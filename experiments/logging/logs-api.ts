/**
 * experiments/logging/logs-api.ts —— 经应用的 `GET /api/lab/logs`（backend/src/adapters/logging/lab-routes.ts，仅管理员）取服务端证据：
 *   - store=local：实例上倒序扫描当前文件与 .1 的结果、用时与扫描字节（meta.engine=local-scan）；
 *   - store=cloudwatch：FilterLogEvents（行带 eventTs / ingestedAt）与 Logs Insights（queryId → results，meta.scannedBytes）。
 * 工作台上不调用 AWS SDK，也不需要 logs:* 权限：查询由实例角色执行（logging 的 PolicyArn）。
 */
import type { ScenarioContext } from '../_lib/scenario.js';
import { sleep } from '../_lib/util.js';

export interface LogRow {
  ts: string;
  level: string;
  source: string;
  instanceId?: string;
  msg: string;
  requestId?: string;
  fields: Record<string, unknown>;
  sizeBytes?: number;
  eventTs?: string;
  ingestedAt?: string;
}

export interface LogMeta { engine: string; tookMs: number; scannedBytes?: number; instances: string[]; truncated: boolean }

export interface LogsResponse { store: 'local' | 'cloudwatch'; mode: 'sync' | 'async'; rows?: LogRow[]; queryId?: string; meta?: LogMeta }

export class LogsApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = 'LogsApiError';
  }
}

export interface LogsQuery {
  store: 'local' | 'cloudwatch';
  source?: string;
  level?: string;
  q?: string;
  requestId?: string;
  from?: string;
  to?: string;
  limit?: number;
}

export function logsPath(q: LogsQuery): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== '') p.set(k, String(v));
  return `/api/lab/logs?${p.toString()}`;
}

/** GET /api/lab/logs；返回 tookMs = 客户端看到的往返时间（服务端的 meta.tookMs 另记） */
export async function queryLogs(ctx: Pick<ScenarioContext, 'client'>, q: LogsQuery): Promise<LogsResponse & { roundTripMs: number }> {
  const t0 = performance.now();
  const res = await ctx.client.get(logsPath(q), { route: '/api/lab/logs', record: false, timeoutMs: 60_000 });
  const roundTripMs = Math.round(performance.now() - t0);
  if (!res.ok) {
    let code = 'HTTP_ERROR';
    let message = res.error ?? `HTTP ${res.status}`;
    try {
      const b = res.json<{ error?: string; message?: string }>();
      code = b.error ?? code;
      message = b.message ?? message;
    } catch {
      /* 非 JSON */
    }
    if (res.status === 404) message = 'GET /api/lab/logs 不存在：实例上的应用版本还没有 logging 的 /lab 侧路端点（backend/src/adapters/logging/lab-routes.ts）';
    throw new LogsApiError(res.status, code, message);
  }
  return { ...res.json<LogsResponse>(), roundTripMs };
}

/** Logs Insights：发起后轮询 results，直到 done 或超时 */
export async function insights(ctx: Pick<ScenarioContext, 'client' | 'signal'>, q: Omit<LogsQuery, 'store'> & { q: string }, timeoutMs = 60_000):
Promise<{ rows: LogRow[]; meta: LogMeta; wallMs: number }> {
  const t0 = performance.now();
  const started = await queryLogs(ctx, { ...q, store: 'cloudwatch' });
  if (started.mode !== 'async' || !started.queryId) throw new LogsApiError(500, 'NOT_ASYNC', 'Logs Insights 语句没有返回 queryId');
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await ctx.client.get(`/api/lab/logs/results/${encodeURIComponent(started.queryId)}`, { route: '/api/lab/logs/results/:queryId', record: false });
    if (!res.ok) throw new LogsApiError(res.status, 'RESULTS_FAILED', res.text().slice(0, 300));
    const body = res.json<{ done: boolean; rows: LogRow[]; meta: LogMeta }>();
    if (body.done) return { rows: body.rows, meta: body.meta, wallMs: Math.round(performance.now() - t0) };
    if (Date.now() > deadline) throw new LogsApiError(504, 'INSIGHTS_TIMEOUT', `Logs Insights ${timeoutMs / 1000} 秒内没有完成`);
    await sleep(1000, ctx.signal);
  }
}

/** Nginx 访问日志行按 uri 计数（status ≥ 500） */
export function errorsByUri(rows: readonly LogRow[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) {
    const status = Number(r.fields.status);
    if (!(status >= 500)) continue;
    const uri = String(r.fields.uri ?? '?');
    out[uri] = (out[uri] ?? 0) + 1;
  }
  return out;
}

/** Logs Insights 的 stats 结果（fields: uri, errors）→ { uri: n } */
export function statsByUri(rows: readonly LogRow[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) {
    const uri = String(r.fields.uri ?? '?');
    const n = Number(r.fields.errors ?? r.fields['count(*)'] ?? 0);
    out[uri] = (out[uri] ?? 0) + (Number.isFinite(n) ? n : 0);
  }
  return out;
}

export function sum(o: Readonly<Record<string, number>>): number {
  return Object.values(o).reduce((a, b) => a + b, 0);
}

