// backend/src/adapters/monitoring/cw-buffer.ts —— CloudWatch 自定义指标的进程内聚合（05#monitoring 第 2、3 节）
//
// cloudwatch 档 = local + 批量上报：两次 flush 之间的数据按 (指标名, 维度) 聚合，flush 时一次性取出。
//   - 计数（counter）：Value = 累计值（Unit Count）；
//   - 分布（histogram、gauge）：Values + Counts 上报原始分布，CloudWatch 才能算 p95（统计集 StatisticValues 拿不到百分位）。
//     不同取值超过 MAX_VALUES 时改为对数分桶（每个 2 的 1/4 次幂一个桶，代表值取桶的几何中点），与 LabMetricsStore 的分桶一致。
// 维度只取总纲 4.2 的白名单 route | module | driver | outcome | job（CloudWatch 中写作 Route、Module、Driver、Outcome、Job）；
// requestId、userId、photoId 这类高基数字段永远不当维度——每种维度组合都是一个单独计费的自定义指标。
// 本文件不依赖 @aws-sdk：MetricDatum 是与 SDK 同形的普通对象，由 cloudwatch.ts 交给 PutMetricData。
import type { Dims } from '../../ports/metrics.js';

export type CwUnit = 'Count' | 'Milliseconds' | 'Bytes' | 'None' | 'Percent';

export const DIM_NAMES = { route: 'Route', module: 'Module', driver: 'Driver', outcome: 'Outcome', job: 'Job' } as const;
const DIM_KEYS = Object.keys(DIM_NAMES) as Array<keyof typeof DIM_NAMES>;

/** 每个 MetricDatum 的 Values 数组上限（以官方文档为准，这里取保守值） */
export const MAX_VALUES = 150;
/** 每次 PutMetricData 的 MetricDatum 数（以官方文档为准，这里取保守值；实际再按负载大小切分） */
export const MAX_DATUMS_PER_CALL = 150;
/** 每次 PutMetricData 的负载估算上限（字节；以官方文档为准，留足余量） */
export const MAX_PAYLOAD_BYTES = 200_000;
/** 维度值最多保留的字符数 */
const MAX_DIM_VALUE = 255;

/** 业务代码里的指标名 → CloudWatch 指标名（文档第 2 节的清单；其余按 PascalCase 转换） */
const KNOWN_NAMES: Readonly<Record<string, string>> = {
  'cache.requests': 'CacheRequests',
  'job.duration': 'JobDuration',
  'queue.depth': 'QueueDepth',
  'photo.uploads': 'PhotoUploads',
  'thumbnail.generated': 'ThumbnailGenerated',
  'log.events': 'LogEvents',
  'process.heartbeat': 'ProcessHeartbeat',
};

export function cwMetricName(name: string): string {
  const known = KNOWN_NAMES[name];
  if (known) return known;
  const pascal = name.split(/[^A-Za-z0-9]+/).filter(Boolean).map((s) => s[0]!.toUpperCase() + s.slice(1)).join('');
  return (pascal || 'Unnamed').slice(0, 255);
}

export interface CwDimension { Name: string; Value: string }

/** 白名单维度 → CloudWatch 维度（按固定顺序，空值丢弃） */
export function cwDimensions(dims?: Dims): CwDimension[] {
  const out: CwDimension[] = [];
  for (const k of DIM_KEYS) {
    const v = dims?.[k];
    if (v === undefined || v === null || v === '') continue;
    out.push({ Name: DIM_NAMES[k], Value: String(v).slice(0, MAX_DIM_VALUE) });
  }
  return out;
}

export function unitOf(u: 'ms' | 'bytes' | 'count' | 'none'): CwUnit {
  return u === 'ms' ? 'Milliseconds' : u === 'bytes' ? 'Bytes' : u === 'count' ? 'Count' : 'None';
}

/** 与 SDK 的 MetricDatum 同形（只用到的字段） */
export interface MetricDatumLike {
  MetricName: string;
  Dimensions?: CwDimension[];
  Unit: CwUnit;
  Timestamp: Date;
  Value?: number;
  Values?: number[];
  Counts?: number[];
  StorageResolution: 60;
}

/** 对数分桶的代表值：2^((i+0.5)/4)，i = floor(log2(v)·4)；v ≤ 0 → 0 */
export function quantize(v: number): number {
  if (!(v > 0) || !Number.isFinite(v)) return 0;
  const i = Math.floor(Math.log2(v) * 4);
  return Math.round(2 ** ((i + 0.5) / 4) * 1000) / 1000;
}

interface Series {
  name: string;
  unit: CwUnit;
  dims: CwDimension[];
  kind: 'sum' | 'values';
  sum: number;
  /** 取值 → 次数 */
  values: Map<number, number>;
  quantized: boolean;
  timestamp?: Date;
}

function keyOf(name: string, dims: CwDimension[]): string {
  return dims.length ? `${name}|${dims.map((d) => `${d.Name}=${d.Value}`).join(',')}` : name;
}

export class CwBuffer {
  private series = new Map<string, Series>();
  /** 因超过序列上限而丢弃的数据点 */
  dropped = 0;

  constructor(private readonly maxSeries = 1000) {}

  get size(): number {
    return this.series.size;
  }

  private get(name: string, dims: CwDimension[], unit: CwUnit, kind: Series['kind']): Series | undefined {
    const k = keyOf(name, dims);
    let s = this.series.get(k);
    if (!s) {
      if (this.series.size >= this.maxSeries) {
        this.dropped += 1;
        return undefined;
      }
      s = { name, unit, dims, kind, sum: 0, values: new Map(), quantized: false };
      this.series.set(k, s);
    }
    return s;
  }

  /** 计数：flush 时上报 Value = 累计值（value = 0 也会建立序列，用于“没有 5xx 也上报 0”） */
  addCount(name: string, dims: CwDimension[], value = 1, unit: CwUnit = 'Count'): void {
    const s = this.get(name, dims, unit, 'sum');
    if (!s) return;
    s.sum += Number.isFinite(value) ? value : 0;
  }

  /** 分布：flush 时上报 Values / Counts */
  addValue(name: string, dims: CwDimension[], value: number, unit: CwUnit, timestamp?: Date): void {
    if (!Number.isFinite(value)) return;
    const s = this.get(name, dims, unit, 'values');
    if (!s) return;
    if (timestamp) s.timestamp = timestamp;
    const v = s.quantized ? quantize(value) : Math.round(value * 1000) / 1000;
    s.values.set(v, (s.values.get(v) ?? 0) + 1);
    if (!s.quantized && s.values.size > MAX_VALUES) {
      const merged = new Map<number, number>();
      for (const [x, c] of s.values) {
        const q = quantize(x);
        merged.set(q, (merged.get(q) ?? 0) + c);
      }
      s.values = merged;
      s.quantized = true;
    }
  }

  /** 取出全部序列（并清空），转换为 MetricDatum；Values 超过上限时拆成多个同名 datum */
  drain(now: Date = new Date()): MetricDatumLike[] {
    const out: MetricDatumLike[] = [];
    for (const s of this.series.values()) {
      const base = { MetricName: s.name, ...(s.dims.length ? { Dimensions: s.dims } : {}), Unit: s.unit, Timestamp: s.timestamp ?? now, StorageResolution: 60 as const };
      if (s.kind === 'sum') {
        out.push({ ...base, Value: s.sum });
        continue;
      }
      const entries = [...s.values.entries()].sort((a, b) => a[0] - b[0]);
      for (let i = 0; i < entries.length; i += MAX_VALUES) {
        const chunk = entries.slice(i, i + MAX_VALUES);
        out.push({ ...base, Values: chunk.map(([v]) => v), Counts: chunk.map(([, c]) => c) });
      }
    }
    this.series = new Map();
    return out;
  }

  /** 只读快照（EMF 模式与测试用；不清空） */
  peek(): ReadonlyArray<Readonly<Series>> {
    return [...this.series.values()];
  }
}

/** 估算一个 datum 序列化后的字节数（用于按负载切分批次） */
export function datumBytes(d: MetricDatumLike): number {
  return JSON.stringify(d).length + 64;
}

/** 按条数与负载大小切分批次 */
export function batches(data: readonly MetricDatumLike[], maxDatums = MAX_DATUMS_PER_CALL, maxBytes = MAX_PAYLOAD_BYTES): MetricDatumLike[][] {
  const out: MetricDatumLike[][] = [];
  let cur: MetricDatumLike[] = [];
  let bytes = 0;
  for (const d of data) {
    const b = datumBytes(d);
    if (cur.length && (cur.length >= maxDatums || bytes + b > maxBytes)) {
      out.push(cur);
      cur = [];
      bytes = 0;
    }
    cur.push(d);
    bytes += b;
  }
  if (cur.length) out.push(cur);
  return out;
}

/** 路由维度的基数上限：每个 flush 周期最多这么多个不同的 Route，其余归入 Route=other */
export class RouteLimiter {
  private readonly seen = new Set<string>();

  constructor(private readonly max = 50) {}

  admit(route: string): string {
    const r = route || 'unknown';
    if (this.seen.has(r)) return r;
    if (this.seen.size >= this.max) return 'other';
    this.seen.add(r);
    return r;
  }

  reset(): void {
    this.seen.clear();
  }
}
