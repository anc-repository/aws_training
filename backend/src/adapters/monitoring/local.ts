// backend/src/adapters/monitoring/local.ts —— MetricsPort 的 `local` 驱动（本地实现，05#monitoring 第 1 节）
//
// 请求、端口调用、主机采样由 LabMetricsStore（始终开启，与 METRICS_DRIVER 无关）自动采集；本驱动只承接业务代码显式上报的
// 自定义指标（counter / histogram / gauge），在进程内聚合，供 /lab 与本地告警评估器读取（snapshot()）。
// 维度只允许白名单（route / module / driver / outcome / job），防止高基数。cloudwatch 档 = 本驱动 + 批量 PutMetricData。
import type { AdapterDeps } from '../types.js';
import type { AdapterMeta, ProbeResult } from '../../ports/common.js';
import type { Dims, MetricsPort } from '../../ports/metrics.js';
import { LogHistogram } from '../../observability/lab-metrics.js';

const DIM_KEYS = ['route', 'module', 'driver', 'outcome', 'job'] as const;
const MAX_SERIES = 2000;

export function seriesKey(name: string, dims?: Dims): string {
  const parts = DIM_KEYS.filter((k) => dims?.[k] !== undefined).map((k) => `${k}=${dims![k]}`);
  return parts.length ? `${name}{${parts.join(',')}}` : name;
}

export interface MetricsSnapshot {
  counters: Record<string, number>;
  gauges: Record<string, { value: number; at: string }>;
  histograms: Record<string, { unit: 'ms' | 'bytes' | 'count'; count: number; sum: number; max: number; p50: number; p95: number; p99: number }>;
}

export class LocalMetrics implements MetricsPort {
  readonly meta: AdapterMeta = { module: 'monitoring', driver: 'local', awsService: null, authoritative: false };
  private readonly counters = new Map<string, number>();
  private readonly gauges = new Map<string, { value: number; at: string }>();
  private readonly histograms = new Map<string, { unit: 'ms' | 'bytes' | 'count'; h: LogHistogram }>();
  private droppedSeries = 0;

  constructor(protected readonly deps: AdapterDeps) {}

  private seriesCount(): number {
    return this.counters.size + this.gauges.size + this.histograms.size;
  }

  private admit(key: string, existing: boolean): boolean {
    if (existing || this.seriesCount() < MAX_SERIES) return true;
    this.droppedSeries += 1;
    return false;
  }

  counter(name: string, value = 1, dims?: Dims): void {
    const k = seriesKey(name, dims);
    if (!this.admit(k, this.counters.has(k))) return;
    this.counters.set(k, (this.counters.get(k) ?? 0) + value);
  }

  histogram(name: string, value: number, unit: 'ms' | 'bytes' | 'count', dims?: Dims): void {
    const k = seriesKey(name, dims);
    let cur = this.histograms.get(k);
    if (!cur) {
      if (!this.admit(k, false)) return;
      cur = { unit, h: new LogHistogram() };
      this.histograms.set(k, cur);
    }
    cur.h.add(value);
  }

  gauge(name: string, value: number, dims?: Dims): void {
    const k = seriesKey(name, dims);
    if (!this.admit(k, this.gauges.has(k))) return;
    this.gauges.set(k, { value, at: new Date().toISOString() });
  }

  snapshot(): MetricsSnapshot {
    const histograms: MetricsSnapshot['histograms'] = {};
    for (const [k, { unit, h }] of this.histograms) {
      histograms[k] = { unit, count: h.count, sum: h.sum, max: h.max, p50: h.percentile(50), p95: h.percentile(95), p99: h.percentile(99) };
    }
    return { counters: Object.fromEntries(this.counters), gauges: Object.fromEntries(this.gauges), histograms };
  }

  /** 本地驱动没有远端：flush 为空操作（LabMetricsStore 自己每 10 秒落库） */
  async flush(): Promise<void> {}

  async probe(_opts?: { deep?: boolean }): Promise<ProbeResult> {
    const lab = this.deps.labMetrics?.status();
    const data = { series: this.seriesCount(), droppedSeries: this.droppedSeries, ...(lab ? { labMetrics: lab } : {}) };
    if (lab?.lastFlushError) {
      return { status: 'degraded', detail: `本地指标库落库失败：${lab.lastFlushError}`, data };
    }
    return { status: 'ok', detail: `本地指标库（LabMetricsStore，始终开启）+ /lab 图表 · 自定义指标 ${this.seriesCount()} 条序列`, data };
  }
}
