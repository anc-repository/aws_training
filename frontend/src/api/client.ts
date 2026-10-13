// 前端唯一的 HTTP 出口（总纲 7.4）：包装 fetch，解析每个响应的 Server-Timing、X-CloudAlbum-Path、X-CloudAlbum-Request-Id、
// X-CloudAlbum-Bypass，连同浏览器侧耗时写入 TraceStore。
//
// - 会话是 BFF + HttpOnly Cookie（ca_at / ca_rt / ca_it），前端 JS 不接触令牌；401 时单飞调用 POST /api/auth/refresh 后重试一次。
// - 只有 Cognito 的 Amplify 变体（lab 选读）会设置 bearer 令牌提供者，此时附带 Authorization: Bearer。
// - 管理员的运行时 A/B：opts.bypass → X-Compare-Bypass；实验归属：opts.experiment → X-Experiment-Run / -Label（§7.3、§8.3）。
import { HEADERS, parseServerTiming, type BypassKey } from '@cloudalbum/contracts';
import { recordTrace } from '../trace/TraceStore';
import type { ApiErrorBody } from './types';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  readonly requestId?: string;

  constructor(status: number, code: string, message: string, details?: unknown, requestId?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    if (details !== undefined) this.details = details;
    if (requestId) this.requestId = requestId;
  }

  /** 后端路由还是脚手架桩（501 NOT_IMPLEMENTED） */
  get notImplemented(): boolean {
    return this.status === 501;
  }
}

export type QueryValue = string | number | boolean | null | undefined;

export interface ApiOptions {
  method?: string;
  /** JSON 请求体（自动设置 Content-Type） */
  json?: unknown;
  /** 原始请求体（上传分片、文件） */
  body?: BodyInit | null;
  headers?: Record<string, string>;
  query?: Record<string, QueryValue>;
  bypass?: readonly (BypassKey | string)[];
  experiment?: { run: string; label: string };
  /** 写进 TraceStore 的标签（A/B 运行器用） */
  traceLabel?: string;
  credentials?: RequestCredentials;
  signal?: AbortSignal;
  /** 401 时不尝试刷新会话 */
  noRefresh?: boolean;
  noTrace?: boolean;
  /** 跨域基址（social-api 的 API Gateway 地址）；默认同源 */
  baseUrl?: string;
}

type TokenProvider = () => Promise<string | null>;

let bearerProvider: TokenProvider | null = null;
let refreshInFlight: Promise<boolean> | null = null;
let unauthorizedListener: (() => void) | null = null;

/** Amplify 变体：浏览器直接持有 Cognito 令牌时，经 Authorization: Bearer 发给 API */
export function setBearerTokenProvider(p: TokenProvider | null): void {
  bearerProvider = p;
}

/** 刷新失败（会话过期）时通知认证层 */
export function onUnauthorized(listener: (() => void) | null): void {
  unauthorizedListener = listener;
}

export function buildUrl(path: string, query?: Record<string, QueryValue>, baseUrl?: string): string {
  let url = baseUrl ? `${baseUrl.replace(/\/+$/, '')}${path.startsWith('/') ? path : `/${path}`}` : path;
  if (query) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === '') continue;
      qs.set(k, String(v));
    }
    const s = qs.toString();
    if (s) url += (url.includes('?') ? '&' : '?') + s;
  }
  return url;
}

function absoluteUrl(url: string): string {
  try {
    return new URL(url, globalThis.location?.href ?? 'http://localhost/').href;
  } catch {
    return url;
  }
}

function isAuthPath(path: string): boolean {
  return /^\/api\/auth\//.test(path);
}

function nowMs(): number {
  return globalThis.performance?.now?.() ?? Date.now();
}

async function rawFetch(path: string, opts: ApiOptions): Promise<Response> {
  const url = buildUrl(path, opts.query, opts.baseUrl);
  const method = (opts.method ?? (opts.json !== undefined ? 'POST' : 'GET')).toUpperCase();
  const headers = new Headers(opts.headers);
  let body: BodyInit | null | undefined = opts.body;
  if (opts.json !== undefined) {
    headers.set('Content-Type', 'application/json');
    body = JSON.stringify(opts.json);
  }
  if (!headers.has('Accept')) headers.set('Accept', 'application/json');
  const bypass = (opts.bypass ?? []).filter(Boolean);
  if (bypass.length) headers.set(HEADERS.compareBypass, bypass.join(','));
  if (opts.experiment) {
    headers.set(HEADERS.experimentRun, opts.experiment.run);
    headers.set(HEADERS.experimentLabel, opts.experiment.label);
  }
  if (bearerProvider && !headers.has('Authorization')) {
    const token = await bearerProvider().catch(() => null);
    if (token) headers.set('Authorization', `Bearer ${token}`);
  }

  const init: RequestInit = {
    method,
    headers,
    credentials: opts.credentials ?? (opts.baseUrl ? 'omit' : 'same-origin'),
  };
  if (body !== undefined) init.body = body;
  if (opts.signal) init.signal = opts.signal;

  const start = nowMs();
  try {
    const res = await globalThis.fetch(url, init);
    if (!opts.noTrace) {
      const requestId = res.headers.get(HEADERS.requestId) ?? undefined;
      const bypassed = (res.headers.get(HEADERS.bypass) ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      recordTrace({
        startTime: start,
        method,
        url: absoluteUrl(url),
        status: res.status,
        durationMs: nowMs() - start,
        serverTiming: parseServerTiming(res.headers.get(HEADERS.serverTiming)),
        pathRaw: res.headers.get(HEADERS.path) ?? '',
        bypassed,
        requestedBypass: bypass.map(String),
        ...(requestId ? { requestId } : {}),
        ...(opts.traceLabel ? { label: opts.traceLabel } : {}),
      });
    }
    return res;
  } catch (e) {
    if (!opts.noTrace && (e as Error)?.name !== 'AbortError') {
      recordTrace({
        startTime: start,
        method,
        url: absoluteUrl(url),
        status: 0,
        durationMs: nowMs() - start,
        serverTiming: [],
        pathRaw: '',
        requestedBypass: bypass.map(String),
        error: (e as Error)?.message ?? String(e),
        ...(opts.traceLabel ? { label: opts.traceLabel } : {}),
      });
    }
    throw e;
  }
}

/** 单飞刷新：并发的多个 401 只触发一次 POST /api/auth/refresh */
export function refreshSession(): Promise<boolean> {
  if (!refreshInFlight) {
    refreshInFlight = rawFetch('/api/auth/refresh', { method: 'POST', noTrace: false })
      .then((r) => r.ok)
      .catch(() => false)
      .finally(() => {
        refreshInFlight = null;
      });
  }
  return refreshInFlight;
}

/** fetch 包装：记录路径追踪；401 时尝试刷新会话并重试一次 */
export async function apiFetch(path: string, opts: ApiOptions = {}): Promise<Response> {
  const res = await rawFetch(path, opts);
  if (res.status === 401 && !opts.noRefresh && !opts.baseUrl && !isAuthPath(path) && !bearerProvider) {
    const ok = await refreshSession();
    if (ok) return rawFetch(path, opts);
    unauthorizedListener?.();
  }
  return res;
}

export async function toApiError(res: Response): Promise<ApiError> {
  let body: Partial<ApiErrorBody> = {};
  try {
    const text = await res.text();
    body = text ? (JSON.parse(text) as ApiErrorBody) : {};
  } catch {
    body = {};
  }
  const requestId = res.headers.get(HEADERS.requestId) ?? body.requestId;
  const code = body.error ?? `HTTP_${res.status}`;
  const message = body.message ?? defaultMessage(res.status, code);
  return new ApiError(res.status, code, message, body.details, requestId ?? undefined);
}

function defaultMessage(status: number, code: string): string {
  if (status === 0) return '网络错误';
  if (status === 401) return '需要登录';
  if (status === 403) return '没有权限';
  if (status === 404) return '不存在';
  if (status === 429) return '请求过于频繁，请稍后再试';
  if (status === 501) return '后端尚未实现这个接口';
  if (status === 503) return '服务暂不可用';
  return `请求失败（${code}）`;
}

/** JSON 接口：非 2xx 抛 ApiError；204 返回 undefined */
export async function api<T>(path: string, opts: ApiOptions = {}): Promise<T> {
  const res = await apiFetch(path, opts);
  if (!res.ok) throw await toApiError(res);
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

/** 人类可读的错误说明（页面的错误提示统一用它） */
export function describeError(e: unknown): string {
  if (e instanceof ApiError) {
    const id = e.requestId ? `（请求 ID ${e.requestId}）` : '';
    return `${e.message}${id}`;
  }
  if (e instanceof Error) return e.message;
  return String(e);
}
