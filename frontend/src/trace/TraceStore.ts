// 请求级“路径追踪”的数据源（总纲 7.4 第 1 条）：api/client.ts 把每个 API 响应的 Server-Timing、X-CloudAlbum-Path、
// X-CloudAlbum-Request-Id 连同浏览器侧耗时写进这里（最近 100 条）；图片与静态资源由 resourceTiming.ts 写进 resources（最近 300 条）。
import { useSyncExternalStore } from 'react';
import { parsePathHeader, type ParsedPath, type ServerTimingMetric } from '@cloudalbum/contracts';

export const TRACE_LIMIT = 100;
export const RESOURCE_LIMIT = 300;

export interface TraceEntry {
  id: number;
  /** epoch ms */
  at: number;
  /** performance.now() 时刻，用来在 Resource Timing 中找到同一次请求 */
  startTime: number;
  method: string;
  /** 绝对 URL */
  url: string;
  /** 路由模板（UUID / ULID / 数字段替换为 :id），用于分组与对比 */
  route: string;
  /** 0 = 网络错误 */
  status: number;
  /** 浏览器侧总耗时（fetch 开始到响应头 + 正文读完） */
  durationMs: number;
  serverTiming: ServerTimingMetric[];
  pathRaw: string;
  path: ParsedPath;
  requestId?: string;
  /** 响应头 X-CloudAlbum-Bypass */
  bypassed: string[];
  /** 本次请求带的 X-Compare-Bypass */
  requestedBypass: string[];
  /** 调用方给的标签（例如 A/B 运行器的 A / B） */
  label?: string;
  error?: string;
}

export interface CdnTimingItem {
  name: string;
  duration: number;
  description: string;
}

export type CdnCacheState = 'HIT' | 'MISS' | 'RefreshHit' | 'unknown';

export interface ResourceRecord {
  url: string;
  initiatorType: string;
  startTime: number;
  duration: number;
  /** 0 时可能是缓存命中，也可能是跨域且没有 Timing-Allow-Origin */
  transferSize: number;
  ttfb: number;
  serverTiming: CdnTimingItem[];
  /** 由 CloudFront 追加的 cdn-* 项推断；拿不到依据时为 unknown（总纲 12.1 第 3 条：前端不猜） */
  cdnState: CdnCacheState;
  timingAllowed: boolean;
}

export interface TraceSnapshot {
  entries: readonly TraceEntry[];
  resources: readonly ResourceRecord[];
  /** 最近一次带路径头的响应（页脚状态条用它显示入口链、实例与 AZ） */
  latestPath: ParsedPath | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/i;
const NUM_RE = /^\d+$/;
const TOKENISH_RE = /^[A-Za-z0-9_-]{20,}$/;

/** `/api/photos/0f8c…/complete?x=1` → `/api/photos/:id/complete` */
export function routeTemplate(url: string): string {
  let pathname = url;
  try {
    pathname = new URL(url, 'http://local.invalid').pathname;
  } catch {
    pathname = url.split('?')[0] ?? url;
  }
  return pathname
    .split('/')
    .map((seg) => (UUID_RE.test(seg) || ULID_RE.test(seg) || NUM_RE.test(seg) || TOKENISH_RE.test(seg) ? ':id' : seg))
    .join('/');
}

let seq = 0;
let snapshot: TraceSnapshot = { entries: [], resources: [], latestPath: null };
const listeners = new Set<() => void>();

function emit(next: TraceSnapshot): void {
  snapshot = next;
  for (const l of listeners) l();
}

export interface TraceInput {
  startTime: number;
  method: string;
  url: string;
  status: number;
  durationMs: number;
  serverTiming: ServerTimingMetric[];
  pathRaw: string;
  requestId?: string;
  bypassed?: string[];
  requestedBypass?: string[];
  label?: string;
  error?: string;
}

export function recordTrace(input: TraceInput): TraceEntry {
  seq += 1;
  const path = parsePathHeader(input.pathRaw);
  const entry: TraceEntry = {
    id: seq,
    at: Date.now(),
    startTime: input.startTime,
    method: input.method.toUpperCase(),
    url: input.url,
    route: routeTemplate(input.url),
    status: input.status,
    durationMs: input.durationMs,
    serverTiming: input.serverTiming,
    pathRaw: input.pathRaw,
    path,
    bypassed: input.bypassed ?? [],
    requestedBypass: input.requestedBypass ?? [],
    ...(input.requestId ? { requestId: input.requestId } : {}),
    ...(input.label ? { label: input.label } : {}),
    ...(input.error ? { error: input.error } : {}),
  };
  const entries = [entry, ...snapshot.entries].slice(0, TRACE_LIMIT);
  emit({ ...snapshot, entries, latestPath: input.pathRaw ? path : snapshot.latestPath });
  return entry;
}

export function recordResource(r: ResourceRecord): void {
  const resources = [r, ...snapshot.resources.filter((x) => x.url !== r.url)].slice(0, RESOURCE_LIMIT);
  emit({ ...snapshot, resources });
}

export function findResource(url: string): ResourceRecord | undefined {
  let abs = url;
  try {
    abs = new URL(url, globalThis.location?.href ?? 'http://local.invalid').href;
  } catch {
    /* 保持原样 */
  }
  return snapshot.resources.find((r) => r.url === abs || r.url === url);
}

export function clearTraces(): void {
  emit({ entries: [], resources: snapshot.resources, latestPath: snapshot.latestPath });
}

/** 测试用 */
export function resetTraceStore(): void {
  seq = 0;
  emit({ entries: [], resources: [], latestPath: null });
}

export function getTraceSnapshot(): TraceSnapshot {
  return snapshot;
}

export function subscribeTraces(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function useTraces(): TraceSnapshot {
  return useSyncExternalStore(subscribeTraces, getTraceSnapshot, getTraceSnapshot);
}

/** 最近一次匹配（方法 + 路由模板）的请求；页面用它取得“这一次”的请求级徽章（例如时间线的 cache= 段） */
export function latestTrace(entries: readonly TraceEntry[], method: string, route: string | RegExp): TraceEntry | undefined {
  const m = method.toUpperCase();
  return entries.find((e) => e.method === m && (typeof route === 'string' ? e.route === route : route.test(e.route)));
}

/** Server-Timing 某一项的调用次数（desc 末尾的 ` x3`；没有 desc 视为 1 次，没有该项为 0） */
export function timingCount(entry: TraceEntry | undefined, name: string): number {
  const m = entry?.serverTiming.find((x) => x.name === name);
  if (!m) return 0;
  const x = /\sx(\d+)$/.exec(m.desc ?? '');
  return x ? Number.parseInt(x[1]!, 10) : 1;
}
