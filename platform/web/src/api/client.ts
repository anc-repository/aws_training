/**
 * API 客户端（08 §2.6、01 §8.1、§7.5）。只按 `@atl/shared` 的路由表（ROUTES，01 §8.2）调用，不手写路径：
 *
 * - 路由 id → 方法与路径；只允许浏览器可用的路由族（jwt、public），agent / internal 路由与 08 §9.2 尚未登记的路由无法调用；
 * - 所有 `POST` 与 `PUT …/result`（`route.idempotent`）自动带 `Idempotency-Key`（UUID v4）；同一次用户操作的重试复用同一个键
 *   （`operation(routeId)`，或显式传 idempotencyKey）；
 * - 会话修改类请求传 `ifMatch: ver` → `If-Match: "<ver>"`；
 * - GET 默认做条件请求：按 URL 缓存 ETag 与响应体，带 `If-None-Match`，`304` 时返回缓存（notModified = true）；
 * - 错误统一解析为 ApiError（problem+json）；`401` 先静默刷新一次再重试，仍失败交给 onUnauthenticated（P13 #5）；
 *   `403 REAUTH_REQUIRED` 交给 onReauthRequired（ReauthDialog，P13 #6）；网络错误与 5xx 通知 onTransientFailure（离线条与退避）。
 */
import { API_PREFIX, routeById, type ResolvedRouteDef, type RouteId } from '@atl/shared';
import { uuidV4 } from '../lib/uuid';
import { ApiError, errorFromResponse, networkError } from './errors';
import { getLocale } from '../i18n/core';

export interface TokenSource {
  /** 当前访问令牌（快过期时由实现先刷新）；没有登录时返回 null。 */
  getAccessToken(): Promise<string | null>;
  /** 收到 401 后强制刷新一次；成功返回 true。 */
  refresh(): Promise<boolean>;
}

export interface ClientHooks {
  onUnauthenticated?: (err: ApiError) => void;
  onReauthRequired?: (err: ApiError, request: PendingRequest) => void;
  onTransientFailure?: (err: ApiError) => void;
  onSuccess?: () => void;
}

export type QueryValue = string | number | boolean | null | undefined;

export interface CallOptions {
  params?: Record<string, string>;
  query?: Record<string, QueryValue>;
  body?: unknown;
  /** `If-Match: "<ver>"`（01 §7.5 第 4 条）。 */
  ifMatch?: number | string;
  idempotencyKey?: string;
  /** GET 的条件请求（默认 true）。 */
  conditional?: boolean;
  signal?: AbortSignal;
}

export interface ApiResponse<T> {
  status: number;
  data: T | null;
  etag: string | null;
  notModified: boolean;
  headers: Headers;
}

/** 可重放的请求（需要重新登录后 15 分钟内自动重放，P13 #6）。 */
export interface PendingRequest {
  routeId: RouteId;
  opts: Omit<CallOptions, 'signal'>;
  createdAt: number;
}

export interface ApiClientOptions {
  /** `config.json` 的 apiBase（默认 `/api/v1`）。 */
  apiBase?: string;
  tokens: TokenSource;
  hooks?: ClientHooks;
  fetchImpl?: typeof fetch;
  /** ETag 缓存条数上限。 */
  cacheSize?: number;
}

const BROWSER_KINDS = new Set(['jwt', 'public']);

export function buildPath(route: ResolvedRouteDef, params: Record<string, string> = {}): string {
  return route.path.replace(/\{(\w+)\}/g, (_m, name: string) => {
    const v = params[name];
    if (v === undefined || v === '') throw new TypeError(`route ${route.id}: missing path parameter "${name}"`);
    return encodeURIComponent(v);
  });
}

export function buildQuery(query: Record<string, QueryValue> = {}): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') sp.set(k, String(v));
  const s = sp.toString();
  return s ? `?${s}` : '';
}

export class ApiClient {
  private readonly base: string;
  private readonly tokens: TokenSource;
  private readonly hooks: ClientHooks;
  private readonly fetchImpl: typeof fetch;
  private readonly cache = new Map<string, { etag: string; body: unknown }>();
  private readonly cacheSize: number;

  constructor(opts: ApiClientOptions) {
    this.base = (opts.apiBase ?? API_PREFIX).replace(/\/+$/, '');
    this.tokens = opts.tokens;
    this.hooks = opts.hooks ?? {};
    this.fetchImpl = opts.fetchImpl ?? ((...a) => globalThis.fetch(...a));
    this.cacheSize = opts.cacheSize ?? 200;
  }

  /** 路由 id 对应的完整 URL（不含查询串时可用于 Location 比对）。 */
  url(routeId: RouteId, params?: Record<string, string>, query?: Record<string, QueryValue>): string {
    const route = this.browserRoute(routeId);
    return `${this.base}${buildPath(route, params)}${buildQuery(query)}`;
  }

  async call<T>(routeId: RouteId, opts: CallOptions = {}): Promise<ApiResponse<T>> {
    const route = this.browserRoute(routeId);
    const url = `${this.base}${buildPath(route, opts.params)}${buildQuery(opts.query)}`;
    const idempotencyKey = route.idempotent ? (opts.idempotencyKey ?? uuidV4()) : undefined;
    const pending: PendingRequest = { routeId, opts: { ...opts, ...(idempotencyKey ? { idempotencyKey } : {}) }, createdAt: Date.now() };
    let refreshed = false;
    for (;;) {
      const res = await this.send(route, url, opts, idempotencyKey);
      if (res.status === 401 && route.kind === 'jwt' && !refreshed) {
        refreshed = true;
        const ok = await this.tokens.refresh().catch(() => false);
        if (ok) continue;
      }
      return this.finish<T>(route, url, res, pending);
    }
  }

  /** 只要数据：`204` 返回 null。 */
  async get<T>(routeId: RouteId, opts: CallOptions = {}): Promise<T | null> {
    return (await this.call<T>(routeId, opts)).data;
  }

  /** 一次用户操作：多次 run() 复用同一个 Idempotency-Key（01 §7.5“同一次用户操作的重试复用同一个键”）。 */
  operation(routeId: RouteId): { key: string; run: <T>(opts?: Omit<CallOptions, 'idempotencyKey'>) => Promise<ApiResponse<T>> } {
    const key = uuidV4();
    return { key, run: <T>(opts: Omit<CallOptions, 'idempotencyKey'> = {}) => this.call<T>(routeId, { ...opts, idempotencyKey: key }) };
  }

  /** 重放保存的请求（重新登录后，同一 Idempotency-Key）。 */
  replay<T>(req: PendingRequest): Promise<ApiResponse<T>> {
    return this.call<T>(req.routeId, req.opts);
  }

  /** 丢弃某个 URL（或前缀）的 ETag 缓存。 */
  invalidate(prefix?: string): void {
    if (!prefix) {
      this.cache.clear();
      return;
    }
    for (const k of [...this.cache.keys()]) if (k.startsWith(prefix)) this.cache.delete(k);
  }

  private browserRoute(routeId: RouteId): ResolvedRouteDef {
    const route = routeById(routeId);
    if (!BROWSER_KINDS.has(route.kind)) throw new TypeError(`route ${routeId} (${route.kind}) is not callable from the browser`);
    return route;
  }

  private async send(route: ResolvedRouteDef, url: string, opts: CallOptions, idempotencyKey: string | undefined): Promise<Response> {
    // 内容类接口按界面语言返回（?lang= 或 Accept-Language，09 §2.5）；错误码在前端按码本地化，detail 只作补充
    const headers: Record<string, string> = { accept: 'application/json, application/problem+json', 'accept-language': getLocale() };
    if (route.kind === 'jwt') {
      const token = await this.tokens.getAccessToken();
      if (token) headers.authorization = `Bearer ${token}`;
    }
    if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
    if (opts.ifMatch !== undefined) headers['if-match'] = `"${String(opts.ifMatch).replace(/"/g, '')}"`;
    const conditional = route.method === 'GET' && opts.conditional !== false;
    const cached = conditional ? this.cache.get(url) : undefined;
    if (cached) headers['if-none-match'] = cached.etag;
    let body: string | undefined;
    if (opts.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(opts.body);
    } else if (route.method === 'POST' || route.method === 'PUT' || route.method === 'PATCH') {
      headers['content-type'] = 'application/json';
      body = '{}';
    }
    try {
      return await this.fetchImpl(url, { method: route.method, headers, body, signal: opts.signal, credentials: 'same-origin', cache: 'no-store' });
    } catch (e) {
      if ((e as { name?: string } | null)?.name === 'AbortError') throw e;
      const err = networkError(e);
      this.hooks.onTransientFailure?.(err);
      throw err;
    }
  }

  private async finish<T>(route: ResolvedRouteDef, url: string, res: Response, pending: PendingRequest): Promise<ApiResponse<T>> {
    const etag = res.headers.get('etag');
    if (res.status === 304) {
      const hit = this.cache.get(url);
      this.hooks.onSuccess?.();
      if (hit) {
        this.touch(url, hit);
        return { status: 304, data: hit.body as T, etag: hit.etag, notModified: true, headers: res.headers };
      }
      // 缓存已被淘汰：去掉条件头重新取
      return this.call<T>(pending.routeId, { ...pending.opts, conditional: false });
    }
    const text = await res.text().catch(() => '');
    if (!res.ok) {
      const err = errorFromResponse(res.status, res.headers, text);
      if (err.isTransient) this.hooks.onTransientFailure?.(err);
      else this.hooks.onSuccess?.();
      if (err.status === 401) this.hooks.onUnauthenticated?.(err);
      if (err.code === 'REAUTH_REQUIRED') this.hooks.onReauthRequired?.(err, pending);
      throw err;
    }
    this.hooks.onSuccess?.();
    let data: T | null = null;
    if (res.status !== 204 && text) {
      try {
        data = JSON.parse(text) as T;
      } catch {
        throw new ApiError({ status: res.status, code: 'BAD_RESPONSE', title: 'response is not JSON' });
      }
    }
    if (route.method === 'GET' && etag && data !== null) this.touch(url, { etag, body: data });
    if (route.method === 'GET' && res.status === 204) this.cache.delete(url);
    return { status: res.status, data, etag, notModified: false, headers: res.headers };
  }

  private touch(url: string, entry: { etag: string; body: unknown }): void {
    this.cache.delete(url);
    this.cache.set(url, entry);
    while (this.cache.size > this.cacheSize) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }
}
