// backend/src/observability/lab-metrics.ts —— LabMetricsStore：本地指标采集（总纲 §7.3）
//
// 每个进程中始终开启，与 METRICS_DRIVER 无关（monitoring 启用后只是把同样的数据额外发一份到 CloudWatch）：
//   - 请求记录：内存环形缓冲（最近 5000 条），供路径追踪与最近请求列表；
//   - 延迟分布：按（路由, 路径签名, 实验 runId/label）维护对数分桶直方图（1ms～60s），每 10 秒汇总交给 sink
//     写入 lab_metric_rollups（分钟粒度，含实例 ID）；
//   - 端口调用：instrument 代理记录每个（模块, 驱动, 方法）的次数、耗时、错误；
//   - 进程与主机：每 10 秒采样 CPU、RSS、事件循环延迟、loadavg、steal、内存使用率、网卡收发字节、数据卷用量 → lab_host_samples。
import { readFileSync, statfsSync } from 'node:fs';
import os from 'node:os';
import { monitorEventLoopDelay, performance, type IntervalHistogram } from 'node:perf_hooks';
import type { CallObserver, PortCallEvent } from './instrument.js';

export type ProcessRole = 'api' | 'worker' | 'cli';

// ---------------------------------------------------------------------------------------------
// 对数分桶直方图：边界 2^(i/4) ms，i = 0..64（1ms ～ 65.5s）；桶 0 = <1ms，最后一桶 = 溢出
// ---------------------------------------------------------------------------------------------
export const HIST_EDGES_MS: readonly number[] = Array.from({ length: 65 }, (_v, i) => 2 ** (i / 4));
export const HIST_BUCKETS = HIST_EDGES_MS.length + 1;

export function bucketIndex(ms: number): number {
  if (!(ms >= 1)) return 0;
  const i = Math.floor(Math.log2(ms) * 4) + 1;
  return Math.min(i, HIST_BUCKETS - 1);
}

export class LogHistogram {
  counts: number[] = new Array<number>(HIST_BUCKETS).fill(0);
  count = 0;
  sum = 0;
  max = 0;

  add(ms: number): void {
    const v = Number.isFinite(ms) && ms > 0 ? ms : 0;
    this.counts[bucketIndex(v)]! += 1;
    this.count += 1;
    this.sum += v;
    if (v > this.max) this.max = v;
  }

  merge(other: { counts: readonly number[]; count: number; sum: number; max: number }): void {
    for (let i = 0; i < HIST_BUCKETS; i += 1) this.counts[i]! += other.counts[i] ?? 0;
    this.count += other.count;
    this.sum += other.sum;
    this.max = Math.max(this.max, other.max);
  }

  /** 近似百分位：返回所在桶的上边界（毫秒），不超过实际最大值 */
  percentile(p: number): number {
    if (!this.count) return 0;
    const rank = Math.ceil((p / 100) * this.count);
    let acc = 0;
    for (let i = 0; i < HIST_BUCKETS; i += 1) {
      acc += this.counts[i] ?? 0;
      if (acc >= rank) {
        const upper = i === 0 ? 1 : (HIST_EDGES_MS[i] ?? this.max);
        return Math.min(upper, this.max);
      }
    }
    return this.max;
  }

  static from(data: { counts: readonly number[]; count: number; sum: number; max: number }): LogHistogram {
    const h = new LogHistogram();
    h.merge(data);
    return h;
  }
}

// ---------------------------------------------------------------------------------------------
// 记录与汇总的数据形状（与 db/migrations 中的 lab 表对应）
// ---------------------------------------------------------------------------------------------
export interface RequestRecord {
  ts: string;
  requestId: string;
  method: string;
  /** 路由模板，例如 /api/photos/:id（未匹配路由时为原始路径的前缀） */
  route: string;
  status: number;
  totalMs: number;
  /** 完整 X-CloudAlbum-Path */
  path: string;
  /** 路径签名（去掉 inst / az） */
  pathSig: string;
  /** 各模块耗时（毫秒） */
  modules: Record<string, number>;
  bypass?: string[];
  runId?: string;
  label?: string;
}

/** 状态码分类（`cloudalbum lab-metrics` 的 byStatus，06 PM-14） */
export function statusClassOf(status: number): string {
  if (status >= 500) return '5xx';
  if (status >= 400) return '4xx';
  if (status >= 300) return '3xx';
  return '2xx';
}

export interface MetricRollup {
  /** 分钟起点（ISO，秒为 0） */
  minute: string;
  instanceId: string;
  role: ProcessRole;
  kind: 'route' | 'port';
  route?: string;
  method?: string;
  pathSig?: string;
  module?: string;
  driver?: string;
  op?: string;
  runId?: string;
  label?: string;
  /** 路由汇总的状态码分类（2xx / 3xx / 4xx / 5xx） */
  statusClass?: string;
  count: number;
  errors: number;
  sumMs: number;
  maxMs: number;
  hist: number[];
}

export interface HostSample {
  ts: string;
  instanceId: string;
  role: ProcessRole;
  pid: number;
  cpuPct: number;
  rssBytes: number;
  heapUsedBytes: number;
  eventLoopDelayP99Ms: number;
  loadavg1: number;
  stealPct?: number;
  memUsedRatio: number;
  netRxBytes?: number;
  netTxBytes?: number;
  dataUsedPct?: number;
}

export interface LabMetricsSink {
  writeRollups(rows: MetricRollup[]): Promise<void>;
  writeHostSamples(rows: HostSample[]): Promise<void>;
}

export interface LabMetricsOptions {
  role: ProcessRole;
  instanceId?: () => string;
  /** 数据卷挂载点（statfs 数据卷用量） */
  dataDir?: string;
  ringSize?: number;
  flushIntervalMs?: number;
  hostSampleIntervalMs?: number;
}

interface Accum { key: Omit<MetricRollup, 'count' | 'errors' | 'sumMs' | 'maxMs' | 'hist' | 'instanceId' | 'role'>; hist: LogHistogram; errors: number }

function minuteOf(d: Date): string {
  const m = new Date(d);
  m.setUTCSeconds(0, 0);
  return m.toISOString();
}

function readProcFile(p: string): string | null {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

export class LabMetricsStore implements CallObserver {
  private readonly ring: RequestRecord[] = [];
  private readonly ringSize: number;
  private pending = new Map<string, Accum>();
  private hostPending: HostSample[] = [];
  private sink?: LabMetricsSink;
  private flushTimer?: NodeJS.Timeout;
  private hostTimer?: NodeJS.Timeout;
  private readonly elDelay: IntervalHistogram;
  private lastCpu = process.cpuUsage();
  private lastCpuAt = performance.now();
  private lastProcStat?: { steal: number; total: number };
  private readonly heartbeats = new Map<string, string>();
  /** 自进程启动以来的累计（/metrics 用） */
  private readonly totals = { requests: 0, errors5xx: 0, portCalls: 0, portErrors: 0 };
  private lastFlushAt?: string;
  private lastFlushError?: string;

  constructor(private readonly opts: LabMetricsOptions) {
    this.ringSize = opts.ringSize ?? 5000;
    this.elDelay = monitorEventLoopDelay({ resolution: 20 });
  }

  get role(): ProcessRole {
    return this.opts.role;
  }

  private instanceId(): string {
    try {
      return this.opts.instanceId?.() || os.hostname();
    } catch {
      return os.hostname();
    }
  }

  setSink(sink: LabMetricsSink | undefined): void {
    this.sink = sink;
  }

  start(): void {
    this.elDelay.enable();
    const flushMs = this.opts.flushIntervalMs ?? 10_000;
    const hostMs = this.opts.hostSampleIntervalMs ?? 10_000;
    this.flushTimer = setInterval(() => { void this.flush(); }, flushMs);
    this.hostTimer = setInterval(() => { this.hostPending.push(this.sampleHost()); }, hostMs);
    this.flushTimer.unref();
    this.hostTimer.unref();
  }

  async stop(): Promise<void> {
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.hostTimer) clearInterval(this.hostTimer);
    this.elDelay.disable();
    await this.flush();
  }

  /** 请求结束时由 observability 中间件调用 */
  recordRequest(r: RequestRecord): void {
    this.ring.push(r);
    if (this.ring.length > this.ringSize) this.ring.splice(0, this.ring.length - this.ringSize);
    this.totals.requests += 1;
    if (r.status >= 500) this.totals.errors5xx += 1;
    const key = { minute: minuteOf(new Date(r.ts)), kind: 'route' as const, route: r.route, method: r.method, pathSig: r.pathSig,
      ...(r.runId ? { runId: r.runId } : {}), ...(r.label ? { label: r.label } : {}), statusClass: statusClassOf(r.status) };
    this.accumulate(key, r.totalMs, r.status >= 500);
  }

  /** instrument 代理的观察者接口：端口调用统计 */
  onCall(e: PortCallEvent): void {
    this.totals.portCalls += 1;
    if (!e.ok) this.totals.portErrors += 1;
    const key = { minute: minuteOf(new Date()), kind: 'port' as const, module: e.module, driver: e.driver, op: e.method,
      ...(e.runId ? { runId: e.runId } : {}), ...(e.label ? { label: e.label } : {}) };
    this.accumulate(key, e.ms, !e.ok);
  }

  /** 进程心跳（ec2 的 processes 检查项） */
  heartbeat(name: string = this.opts.role): void {
    this.heartbeats.set(name, new Date().toISOString());
  }

  heartbeatsSnapshot(): Record<string, string> {
    return Object.fromEntries(this.heartbeats);
  }

  private accumulate(key: Accum['key'], ms: number, error: boolean): void {
    const k = JSON.stringify(key);
    let acc = this.pending.get(k);
    if (!acc) {
      acc = { key, hist: new LogHistogram(), errors: 0 };
      this.pending.set(k, acc);
    }
    acc.hist.add(ms);
    if (error) acc.errors += 1;
  }

  /** 最近的请求记录（新的在前） */
  recent(limit = 200, filter: { runId?: string; route?: string } = {}): RequestRecord[] {
    const out: RequestRecord[] = [];
    for (let i = this.ring.length - 1; i >= 0 && out.length < limit; i -= 1) {
      const r = this.ring[i]!;
      if (filter.runId && r.runId !== filter.runId) continue;
      if (filter.route && r.route !== filter.route) continue;
      out.push(r);
    }
    return out;
  }

  /** 由环形缓冲即时计算延迟分布（未落库的数据也可见） */
  summarizeRecent(filter: { runId?: string; route?: string; groupBy?: 'path' | 'route' } = {}): Array<{ group: string; count: number; errors: number; p50: number; p95: number; p99: number; max: number }> {
    const groups = new Map<string, { h: LogHistogram; errors: number }>();
    for (const r of this.ring) {
      if (filter.runId && r.runId !== filter.runId) continue;
      if (filter.route && r.route !== filter.route) continue;
      const g = filter.groupBy === 'route' ? `${r.method} ${r.route}` : `${r.method} ${r.route} | ${r.pathSig}`;
      const cur = groups.get(g) ?? { h: new LogHistogram(), errors: 0 };
      cur.h.add(r.totalMs);
      if (r.status >= 500) cur.errors += 1;
      groups.set(g, cur);
    }
    return [...groups.entries()].map(([group, { h, errors }]) => ({
      group, count: h.count, errors, p50: h.percentile(50), p95: h.percentile(95), p99: h.percentile(99), max: h.max,
    }));
  }

  /** 取出待写入的汇总（并清空） */
  drainRollups(): MetricRollup[] {
    const instanceId = this.instanceId();
    const rows: MetricRollup[] = [];
    for (const acc of this.pending.values()) {
      rows.push({
        ...acc.key, instanceId, role: this.opts.role,
        count: acc.hist.count, errors: acc.errors, sumMs: acc.hist.sum, maxMs: acc.hist.max, hist: [...acc.hist.counts],
      });
    }
    this.pending = new Map();
    return rows;
  }

  drainHostSamples(): HostSample[] {
    const rows = this.hostPending;
    this.hostPending = [];
    return rows;
  }

  /** 每 10 秒：把汇总与主机采样交给 sink（数据库）。sink 失败时数据重新放回，下次重试（只读窗口期间同样暂存在内存）。 */
  async flush(): Promise<void> {
    if (!this.sink) return;
    const rollups = this.drainRollups();
    const hosts = this.drainHostSamples();
    try {
      if (rollups.length) await this.sink.writeRollups(rollups);
      if (hosts.length) await this.sink.writeHostSamples(hosts);
      this.lastFlushAt = new Date().toISOString();
      delete this.lastFlushError;
    } catch (e) {
      this.lastFlushError = (e as Error).message;
      for (const r of rollups) {
        const { instanceId: _i, role: _r, count: _c, errors, sumMs, maxMs, hist, ...key } = r;
        const acc = this.pending.get(JSON.stringify(key)) ?? { key, hist: new LogHistogram(), errors: 0 };
        acc.hist.merge({ counts: hist, count: r.count, sum: sumMs, max: maxMs });
        acc.errors += errors;
        this.pending.set(JSON.stringify(key), acc);
      }
      this.hostPending.unshift(...hosts.slice(-60));
    }
  }

  status(): { lastFlushAt?: string; lastFlushError?: string; pendingRollups: number; ringSize: number } {
    return {
      ...(this.lastFlushAt ? { lastFlushAt: this.lastFlushAt } : {}),
      ...(this.lastFlushError ? { lastFlushError: this.lastFlushError } : {}),
      pendingRollups: this.pending.size,
      ringSize: this.ring.length,
    };
  }

  /** 进程与主机采样（Linux 读 /proc；其他平台退回 os 模块，steal / 网卡字节缺失） */
  sampleHost(): HostSample {
    const now = performance.now();
    const cpu = process.cpuUsage(this.lastCpu);
    const elapsedUs = Math.max(1, (now - this.lastCpuAt) * 1000);
    this.lastCpu = process.cpuUsage();
    this.lastCpuAt = now;
    const mem = process.memoryUsage();
    const sample: HostSample = {
      ts: new Date().toISOString(),
      instanceId: this.instanceId(),
      role: this.opts.role,
      pid: process.pid,
      cpuPct: Math.round(((cpu.user + cpu.system) / elapsedUs) * 1000) / 10,
      rssBytes: mem.rss,
      heapUsedBytes: mem.heapUsed,
      eventLoopDelayP99Ms: Math.round((this.elDelay.percentile(99) / 1e6) * 10) / 10,
      loadavg1: os.loadavg()[0] ?? 0,
      memUsedRatio: 1 - os.freemem() / os.totalmem(),
    };
    this.elDelay.reset();

    const stat = readProcFile('/proc/stat');
    if (stat) {
      const cpuLine = stat.split('\n').find((l) => l.startsWith('cpu '));
      const f = cpuLine?.trim().split(/\s+/).slice(1).map(Number) ?? [];
      const total = f.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
      const steal = f[7] ?? 0;
      if (this.lastProcStat && total > this.lastProcStat.total) {
        sample.stealPct = Math.round(((steal - this.lastProcStat.steal) / (total - this.lastProcStat.total)) * 1000) / 10;
      }
      this.lastProcStat = { steal, total };
    }
    const meminfo = readProcFile('/proc/meminfo');
    if (meminfo) {
      const get = (k: string) => Number(new RegExp(`^${k}:\\s+(\\d+)`, 'm').exec(meminfo)?.[1] ?? NaN);
      const total = get('MemTotal');
      const avail = get('MemAvailable');
      if (total > 0 && avail >= 0) sample.memUsedRatio = 1 - avail / total;
    }
    const netdev = readProcFile('/proc/net/dev');
    if (netdev) {
      let rx = 0;
      let tx = 0;
      for (const line of netdev.split('\n').slice(2)) {
        const [iface, rest] = line.split(':');
        if (!rest || iface?.trim() === 'lo') continue;
        const cols = rest.trim().split(/\s+/).map(Number);
        rx += cols[0] ?? 0;
        tx += cols[8] ?? 0;
      }
      sample.netRxBytes = rx;
      sample.netTxBytes = tx;
    }
    if (this.opts.dataDir) {
      try {
        const s = statfsSync(this.opts.dataDir);
        if (s.blocks > 0) sample.dataUsedPct = Math.round((1 - s.bavail / s.blocks) * 1000) / 10;
      } catch {
        /* 数据目录不存在（开发机） */
      }
    }
    return sample;
  }

  /** GET /metrics（仅本机可访问）的 Prometheus 文本格式 */
  toPrometheus(): string {
    const lines: string[] = [];
    const role = this.opts.role;
    lines.push('# HELP cloudalbum_requests_total HTTP requests handled by this process');
    lines.push('# TYPE cloudalbum_requests_total counter');
    lines.push(`cloudalbum_requests_total{role="${role}"} ${this.totals.requests}`);
    lines.push('# HELP cloudalbum_requests_5xx_total HTTP 5xx responses');
    lines.push('# TYPE cloudalbum_requests_5xx_total counter');
    lines.push(`cloudalbum_requests_5xx_total{role="${role}"} ${this.totals.errors5xx}`);
    lines.push('# HELP cloudalbum_port_calls_total Port (adapter) calls');
    lines.push('# TYPE cloudalbum_port_calls_total counter');
    lines.push(`cloudalbum_port_calls_total{role="${role}"} ${this.totals.portCalls}`);
    lines.push(`cloudalbum_port_errors_total{role="${role}"} ${this.totals.portErrors}`);
    const routes = this.summarizeRecent({ groupBy: 'route' });
    lines.push('# HELP cloudalbum_request_duration_ms Request latency percentiles over the in-memory ring buffer');
    lines.push('# TYPE cloudalbum_request_duration_ms gauge');
    for (const r of routes) {
      const label = r.group.replace(/"/g, '\\"');
      lines.push(`cloudalbum_request_duration_ms{role="${role}",route="${label}",quantile="0.5"} ${r.p50}`);
      lines.push(`cloudalbum_request_duration_ms{role="${role}",route="${label}",quantile="0.95"} ${r.p95}`);
      lines.push(`cloudalbum_request_duration_ms{role="${role}",route="${label}",quantile="0.99"} ${r.p99}`);
    }
    const mem = process.memoryUsage();
    lines.push('# TYPE cloudalbum_process_rss_bytes gauge');
    lines.push(`cloudalbum_process_rss_bytes{role="${role}"} ${mem.rss}`);
    return `${lines.join('\n')}\n`;
  }
}
