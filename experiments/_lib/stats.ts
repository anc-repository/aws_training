/**
 * experiments/_lib/stats.ts —— 客户端侧采集：每个请求的延迟、状态码、Server-Timing、X-CloudAlbum-Path（总纲 §7.1、§7.2）。
 *
 * - 每个样本保留原始延迟（实验规模下内存可控），分位数用最近秩法精确计算。
 * - 维度：路由（`METHOD /route/:id`）、变体（`after:A` / `after:B`）、目标（direct / cdn / alb / apigw / s3 / cognito）、阶段（`vus=50`）、重复轮次。
 * - Server-Timing 的 desc 形如 `postgres@rds x3`：`x3` 累加为端口调用次数（每请求 DB 查询数就是这么来的）。
 */
import { parsePathHeader, parseTimingDesc, pathSignature, type ServerTimingMetric } from '@cloudalbum/contracts';
import type { ClientSlice, ClientSummary, LatencyStats, TimingStats } from './types.js';
import { mean, percentileSorted, round1, round3 } from './util.js';

export interface Sample {
  method: string;
  route: string;
  status: number;
  ok: boolean;
  totalMs: number;
  ttfbMs?: number;
  bytes?: number;
  variant?: string;
  target?: string;
  stage?: string;
  repeat?: number;
  serverTiming?: ServerTimingMetric[];
  pathHeader?: string;
  xCache?: string;
  error?: string;
}

const ID_SEGMENT = [
  /^[0-9A-HJKMNP-TV-Z]{26}$/i, // ULID
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, // UUID
  /^\d+$/,
  /^[0-9a-f]{16,}$/i,
];

/** `/api/photos/01JA…/complete?x=1` → `/api/photos/:id/complete`（调用方没给 route 时的兜底）。 */
export function routeTemplate(pathname: string): string {
  const clean = pathname.split('?')[0]!.split('#')[0]!;
  return clean.split('/').map((seg) => (ID_SEGMENT.some((re) => re.test(seg)) ? ':id' : seg)).join('/') || '/';
}

/** 统一的样本键：`GET /api/feed`。 */
export function routeKey(method: string, route: string): string {
  return `${method.toUpperCase()} ${route}`;
}

/** 状态码是否计为错误：网络错误（0）与 5xx 一定是；4xx 由调用方决定（ok 字段）。 */
export function isErrorSample(s: Sample): boolean {
  return !s.ok;
}

function latencyOf(samples: readonly Sample[]): LatencyStats {
  const durations = samples.map((s) => s.totalMs).sort((a, b) => a - b);
  const ttfb = samples.map((s) => s.ttfbMs).filter((v): v is number => v !== undefined).sort((a, b) => a - b);
  const bytes = samples.reduce((a, s) => a + (s.bytes ?? 0), 0);
  const first = samples[0];
  const stats: LatencyStats = {
    count: samples.length,
    errors: samples.filter(isErrorSample).length,
    p50: round1(percentileSorted(durations, 50)),
    p95: round1(percentileSorted(durations, 95)),
    p99: round1(percentileSorted(durations, 99)),
    max: round1(durations[durations.length - 1]),
    mean: round1(mean(durations)),
  };
  if (first) {
    stats.method = first.method;
    stats.route = first.route;
  }
  if (ttfb.length) {
    stats.ttfbP50 = round1(percentileSorted(ttfb, 50));
    stats.ttfbP95 = round1(percentileSorted(ttfb, 95));
  }
  if (bytes) stats.bytes = bytes;
  return stats;
}

function timingOf(samples: readonly Sample[]): Record<string, TimingStats> {
  const acc = new Map<string, { durs: number[]; calls: number; descs: Map<string, number> }>();
  let withTiming = 0;
  for (const s of samples) {
    if (!s.serverTiming?.length) continue;
    withTiming += 1;
    for (const m of s.serverTiming) {
      const a = acc.get(m.name) ?? { durs: [], calls: 0, descs: new Map<string, number>() };
      if (m.dur !== undefined) a.durs.push(m.dur);
      if (m.desc) {
        const { value, count } = parseTimingDesc(m.desc);
        a.calls += count;
        a.descs.set(value, (a.descs.get(value) ?? 0) + 1);
      } else {
        a.calls += 1;
      }
      acc.set(m.name, a);
    }
  }
  const out: Record<string, TimingStats> = {};
  for (const [name, a] of [...acc.entries()].sort((x, y) => x[0].localeCompare(y[0]))) {
    const sorted = [...a.durs].sort((x, y) => x - y);
    out[name] = {
      count: a.durs.length || a.descs.size,
      p50: round1(percentileSorted(sorted, 50)),
      p95: round1(percentileSorted(sorted, 95)),
      mean: round1(mean(sorted)),
      calls: a.calls,
      callsPerRequest: withTiming ? round3(a.calls / withTiming) : undefined,
      descs: Object.fromEntries([...a.descs.entries()].sort((x, y) => y[1] - x[1])),
    };
  }
  return out;
}

function countBy<T>(items: readonly T[], key: (t: T) => string | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const it of items) {
    const k = key(it);
    if (k === undefined || k === '') continue;
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

function stripUndefined<T extends object>(o: T): T {
  for (const k of Object.keys(o) as Array<keyof T>) if (o[k] === undefined) delete o[k];
  return o;
}

/** 一组样本的汇总（按路由、状态码、Server-Timing、路径签名、模块 outcome）。 */
export function summarizeSlice(samples: readonly Sample[]): ClientSlice {
  const byRoute = new Map<string, Sample[]>();
  for (const s of samples) {
    const k = routeKey(s.method, s.route);
    const list = byRoute.get(k) ?? [];
    list.push(s);
    byRoute.set(k, list);
  }
  const latencyMs: Record<string, LatencyStats> = {};
  for (const k of [...byRoute.keys()].sort()) latencyMs[k] = latencyOf(byRoute.get(k)!);

  const outcomes: Record<string, Record<string, number>> = {};
  const paths: Record<string, number> = {};
  for (const s of samples) {
    if (!s.pathHeader) continue;
    const parsed = parsePathHeader(s.pathHeader);
    const sig = pathSignature(parsed);
    if (sig) paths[sig] = (paths[sig] ?? 0) + 1;
    for (const m of parsed.modules) {
      const bucket = outcomes[m.module] ?? (outcomes[m.module] = {});
      bucket[m.raw] = (bucket[m.raw] ?? 0) + 1;
    }
  }
  const errors = samples.filter(isErrorSample).length;
  return stripUndefined({
    requests: samples.length,
    errors,
    errorRate: samples.length ? round3(errors / samples.length) : undefined,
    latencyMs,
    statusCodes: countBy(samples, (s) => String(s.status)),
    serverTiming: timingOf(samples),
    paths,
    outcomes,
  });
}

/**
 * 采集器：场景的每个请求经 `ExpClient` 写进来；`summary()` 生成结果 JSON 的 `client` 段。
 */
export class Recorder {
  private readonly samples: Sample[] = [];
  private firstAt: number | undefined;
  private lastAt: number | undefined;
  /** 当前阶段 / 轮次标签（由运行器设置，写入之后的样本） */
  stage: string | undefined;
  repeat: number | undefined;

  record(sample: Sample): void {
    const now = performance.now();
    this.firstAt ??= now - sample.totalMs;
    this.lastAt = now;
    this.samples.push({
      ...sample,
      ...(this.stage !== undefined && sample.stage === undefined ? { stage: this.stage } : {}),
      ...(this.repeat !== undefined && sample.repeat === undefined ? { repeat: this.repeat } : {}),
    });
  }

  get size(): number {
    return this.samples.length;
  }

  all(): readonly Sample[] {
    return this.samples;
  }

  filter(pred: (s: Sample) => boolean): Sample[] {
    return this.samples.filter(pred);
  }

  /** 某个路由（或路由前缀匹配）的延迟数组，场景计算自定义发现时用。 */
  durations(method: string, route: string, pred?: (s: Sample) => boolean): number[] {
    return this.samples
      .filter((s) => s.method === method.toUpperCase() && s.route === route && (!pred || pred(s)))
      .map((s) => s.totalMs);
  }

  summary(): ClientSummary {
    const base = summarizeSlice(this.samples);
    const durationMs = this.firstAt !== undefined && this.lastAt !== undefined ? this.lastAt - this.firstAt : undefined;
    const out: ClientSummary = { ...base };
    if (durationMs !== undefined) {
      out.durationMs = Math.round(durationMs);
      out.rps = durationMs > 0 ? round1((this.samples.length / durationMs) * 1000) : undefined;
    }
    const instances = countBy(this.samples, (s) => (s.pathHeader ? parsePathHeader(s.pathHeader).inst : undefined));
    if (Object.keys(instances).length) out.instances = instances;
    const xCache = countBy(this.samples, (s) => s.xCache?.toLowerCase());
    if (Object.keys(xCache).length) out.xCache = xCache;
    const group = (key: (s: Sample) => string | undefined): Record<string, ClientSlice> | undefined => {
      const groups = new Map<string, Sample[]>();
      for (const s of this.samples) {
        const k = key(s);
        if (!k) continue;
        const list = groups.get(k) ?? [];
        list.push(s);
        groups.set(k, list);
      }
      if (groups.size === 0) return undefined;
      return Object.fromEntries([...groups.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([k, v]) => [k, summarizeSlice(v)]));
    };
    const byVariant = group((s) => s.variant);
    if (byVariant && Object.keys(byVariant).length > 1) out.byVariant = byVariant;
    else if (byVariant && Object.keys(byVariant).some((k) => k.includes(':'))) out.byVariant = byVariant;
    const byTarget = group((s) => s.target);
    if (byTarget && (Object.keys(byTarget).length > 1 || !byTarget.direct)) out.byTarget = byTarget;
    const byStage = group((s) => s.stage);
    if (byStage && Object.keys(byStage).length > 1) out.byStage = byStage;
    return stripUndefined(out);
  }

  /** 某一轮（--repeat）的汇总。 */
  sliceForRepeat(index: number): ClientSlice {
    return summarizeSlice(this.samples.filter((s) => s.repeat === index));
  }
}
