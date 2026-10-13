/**
 * experiments/_lib/http.ts —— 基于 undici 的实验 HTTP 客户端。
 *
 * - 自动带管理员令牌（`Authorization: Bearer`）与实验头 `X-Experiment-Run` / `X-Experiment-Label`（§7.3：仅管理员有效）。
 * - `--ab` 时对标记了 `ab: true` 的请求交替加 `X-Compare-Bypass`（§8.3）。约定：**A = 带旁路头（相当于“没有该模块”）**，
 *   **B = 不带（“有”）**，标签分别为 `<label>:A`、`<label>:B`，这样报告里 A→B 与 before→after 的方向一致。
 * - 服务端对旁路请求限速（每管理员每分钟 120 个、每实例 4 个在途），客户端用令牌桶 + 信号量主动限流，避免把 429 计入结果。
 * - 每个响应解析 `Server-Timing`、`X-CloudAlbum-Path`、`X-Cache`，写入 Recorder。
 */
import { HEADERS, parsePathHeader, parseServerTiming, type ParsedPath, type ServerTimingMetric } from '@cloudalbum/contracts';
import { Agent, request, type Dispatcher } from 'undici';
import { routeTemplate, type Recorder } from './stats.js';
import { sleep } from './util.js';

export const USER_AGENT = 'cloudalbum-experiments/0.1 (+experiments/_lib/http.ts)';

export interface RequestOptions {
  headers?: Record<string, string>;
  body?: Buffer | Uint8Array | string;
  /** 以 JSON 发送（自动设置 Content-Type） */
  json?: unknown;
  /** 路由模板（`/api/photos/:id/complete`）；缺省由路径推断 */
  route?: string;
  /** 参与 A/B 交替 */
  ab?: boolean;
  /** 额外的旁路键（显式旁路，不参与交替） */
  bypass?: string[];
  /** 是否带令牌（缺省 true） */
  auth?: boolean;
  /** 是否写入 Recorder（缺省跟随客户端） */
  record?: boolean;
  /** 视为成功的状态码；缺省 2xx / 3xx */
  expect?: number[];
  timeoutMs?: number;
  /** 不读响应体（只要状态与头） */
  discardBody?: boolean;
  /** 覆盖目标标签 */
  target?: string;
}

export interface ExpResponse {
  status: number;
  ok: boolean;
  url: string;
  headers: Record<string, string>;
  setCookie: string[];
  body: Buffer;
  totalMs: number;
  ttfbMs?: number;
  serverTiming: ServerTimingMetric[];
  path: ParsedPath;
  /** A/B 变体（`A` / `B`），未参与交替时为 undefined */
  variant?: 'A' | 'B';
  error?: string;
  text(): string;
  json<T = unknown>(): T;
}

export class ExpHttpError extends Error {
  constructor(readonly response: ExpResponse, message?: string) {
    super(message ?? `${response.status} ${response.url}: ${response.text().slice(0, 300) || response.error || ''}`);
    this.name = 'ExpHttpError';
  }
}

/** A/B 交替状态（同一次运行内共享）。 */
export class AbState {
  private n = 0;
  constructor(readonly bypass: string) {}
  next(): 'A' | 'B' {
    this.n += 1;
    return this.n % 2 === 1 ? 'A' : 'B';
  }
}

/** 旁路请求的客户端限流：令牌桶（每分钟 perMinute）+ 在途上限。 */
export class BypassLimiter {
  private tokens: number;
  private last = performance.now();
  private inFlight = 0;
  private readonly waiters: Array<() => void> = [];
  constructor(private readonly perMinute = 110, private readonly maxInFlight = 4, private readonly burst = 4) {
    this.tokens = burst;
  }

  async acquire(signal?: AbortSignal): Promise<void> {
    for (;;) {
      if (signal?.aborted) return;
      const now = performance.now();
      this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 60_000) * this.perMinute);
      this.last = now;
      if (this.tokens >= 1 && this.inFlight < this.maxInFlight) {
        this.tokens -= 1;
        this.inFlight += 1;
        return;
      }
      if (this.inFlight >= this.maxInFlight) {
        await new Promise<void>((resolve) => this.waiters.push(resolve));
      } else {
        await sleep(Math.ceil(((1 - this.tokens) * 60_000) / this.perMinute), signal);
      }
    }
  }

  release(): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
    this.waiters.shift()?.();
  }
}

export interface ClientOptions {
  base: string;
  token?: string;
  dispatcher?: Dispatcher;
  recorder?: Recorder;
  experiment?: { runId: string; label: string };
  /** 目标标签：direct / cdn / alb / apigw / s3 / cognito */
  target?: string;
  recording?: boolean;
  ab?: AbState;
  limiter?: BypassLimiter;
  signal?: AbortSignal;
  defaultTimeoutMs?: number;
}

let sharedAgent: Agent | undefined;

/** 进程内共享的连接池（keep-alive）。 */
export function sharedDispatcher(): Agent {
  sharedAgent ??= new Agent({ connections: 512, keepAliveTimeout: 10_000, keepAliveMaxTimeout: 30_000 });
  return sharedAgent;
}

export async function closeSharedDispatcher(): Promise<void> {
  const a = sharedAgent;
  sharedAgent = undefined;
  if (a) await a.close().catch(() => undefined);
}

function flattenHeaders(raw: Record<string, string | string[] | undefined>): { headers: Record<string, string>; setCookie: string[] } {
  const headers: Record<string, string> = {};
  let setCookie: string[] = [];
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined) continue;
    const key = k.toLowerCase();
    if (key === 'set-cookie') {
      setCookie = Array.isArray(v) ? v : [v];
      continue;
    }
    headers[key] = Array.isArray(v) ? v.join(', ') : v;
  }
  return { headers, setCookie };
}

function makeResponse(init: Omit<ExpResponse, 'text' | 'json'>): ExpResponse {
  return {
    ...init,
    text() {
      return init.body.toString('utf8');
    },
    json<T>() {
      const s = init.body.toString('utf8');
      return (s ? JSON.parse(s) : null) as T;
    },
  };
}

export class ExpClient {
  readonly base: string;
  readonly target: string;
  private readonly opts: ClientOptions;

  constructor(opts: ClientOptions) {
    this.opts = opts;
    this.base = opts.base.replace(/\/+$/, '');
    this.target = opts.target ?? 'direct';
  }

  get token(): string | undefined {
    return this.opts.token;
  }

  get experiment(): { runId: string; label: string } | undefined {
    return this.opts.experiment;
  }

  /** 派生客户端：共享连接池、采集器与 A/B 状态，覆盖部分选项。 */
  child(overrides: Partial<ClientOptions>): ExpClient {
    return new ExpClient({ ...this.opts, ...overrides });
  }

  url(pathOrUrl: string): string {
    if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
    return `${this.base}${pathOrUrl.startsWith('/') ? '' : '/'}${pathOrUrl}`;
  }

  async request(method: string, pathOrUrl: string, ro: RequestOptions = {}): Promise<ExpResponse> {
    const url = this.url(pathOrUrl);
    const m = method.toUpperCase();
    const headers: Record<string, string> = { 'user-agent': USER_AGENT, accept: 'application/json, */*;q=0.5', ...(ro.headers ?? {}) };
    let body: Buffer | Uint8Array | string | undefined = ro.body;
    if (ro.json !== undefined) {
      body = JSON.stringify(ro.json);
      headers['content-type'] ??= 'application/json';
    }
    // 实验头与旁路头只对管理员有效（非管理员携带会被 403）：只在本客户端注入了自己的令牌时才加
    const callerAuth = Object.keys(headers).some((k) => k.toLowerCase() === 'authorization');
    const injected = ro.auth !== false && Boolean(this.opts.token) && !callerAuth;
    if (injected) headers.authorization = `Bearer ${this.opts.token}`;

    let variant: 'A' | 'B' | undefined;
    const bypass = [...(ro.bypass ?? [])];
    if (ro.ab && this.opts.ab && injected) {
      variant = this.opts.ab.next();
      if (variant === 'A') bypass.push(this.opts.ab.bypass);
    }
    if (bypass.length) headers[HEADERS.compareBypass.toLowerCase()] = [...new Set(bypass)].join(',');
    if (this.opts.experiment && injected) {
      headers[HEADERS.experimentRun.toLowerCase()] = this.opts.experiment.runId;
      headers[HEADERS.experimentLabel.toLowerCase()] = variant ? `${this.opts.experiment.label}:${variant}` : this.opts.experiment.label;
    }

    const limited = bypass.length > 0 && this.opts.limiter !== undefined;
    if (limited) await this.opts.limiter!.acquire(this.opts.signal);

    const timeout = ro.timeoutMs ?? this.opts.defaultTimeoutMs ?? 60_000;
    const started = performance.now();
    let res: ExpResponse;
    try {
      const r = await request(url, {
        method: m as Dispatcher.HttpMethod,
        headers,
        ...(body !== undefined ? { body } : {}),
        dispatcher: this.opts.dispatcher ?? sharedDispatcher(),
        headersTimeout: timeout,
        bodyTimeout: timeout,
        ...(this.opts.signal ? { signal: this.opts.signal } : {}),
      });
      const ttfbMs = performance.now() - started;
      let buf: Buffer = Buffer.alloc(0);
      if (ro.discardBody) await r.body.dump();
      else buf = Buffer.from(await r.body.arrayBuffer());
      const totalMs = performance.now() - started;
      const { headers: h, setCookie } = flattenHeaders(r.headers as Record<string, string | string[] | undefined>);
      const ok = ro.expect ? ro.expect.includes(r.statusCode) : r.statusCode >= 200 && r.statusCode < 400;
      res = makeResponse({
        status: r.statusCode, ok, url, headers: h, setCookie, body: buf, totalMs, ttfbMs,
        serverTiming: parseServerTiming(h['server-timing']),
        path: parsePathHeader(h[HEADERS.path.toLowerCase()]),
        ...(variant ? { variant } : {}),
      });
    } catch (e) {
      const totalMs = performance.now() - started;
      res = makeResponse({
        status: 0, ok: false, url, headers: {}, setCookie: [], body: Buffer.alloc(0), totalMs,
        serverTiming: [], path: parsePathHeader(undefined), ...(variant ? { variant } : {}),
        error: (e as Error).message || String(e),
      });
    } finally {
      if (limited) this.opts.limiter!.release();
    }

    const shouldRecord = (ro.record ?? this.opts.recording ?? true) && this.opts.recorder && !(res.status === 0 && this.opts.signal?.aborted);
    if (shouldRecord) {
      const route = ro.route ?? routeTemplate(new URL(url).pathname);
      const label = this.opts.experiment?.label;
      const pathHeader = res.headers[HEADERS.path.toLowerCase()];
      const xCache = res.headers['x-cache'];
      this.opts.recorder!.record({
        method: m, route, status: res.status, ok: res.ok, totalMs: res.totalMs,
        ...(res.ttfbMs !== undefined ? { ttfbMs: res.ttfbMs } : {}),
        bytes: res.body.length,
        ...(variant && label ? { variant: `${label}:${variant}` } : {}),
        target: ro.target ?? this.target,
        ...(res.serverTiming.length ? { serverTiming: res.serverTiming } : {}),
        ...(pathHeader ? { pathHeader } : {}),
        ...(xCache ? { xCache: xCache.split(' ')[0] } : {}),
        ...(res.error ? { error: res.error } : {}),
      });
    }
    return res;
  }

  get(p: string, ro?: RequestOptions): Promise<ExpResponse> {
    return this.request('GET', p, ro);
  }

  post(p: string, ro?: RequestOptions): Promise<ExpResponse> {
    return this.request('POST', p, ro);
  }

  put(p: string, ro?: RequestOptions): Promise<ExpResponse> {
    return this.request('PUT', p, ro);
  }

  del(p: string, ro?: RequestOptions): Promise<ExpResponse> {
    return this.request('DELETE', p, ro);
  }

  /** 请求并解析 JSON；非成功状态抛 ExpHttpError。 */
  async json<T>(method: string, p: string, ro: RequestOptions = {}): Promise<T> {
    const res = await this.request(method, p, ro);
    if (!res.ok) throw new ExpHttpError(res);
    return res.json<T>();
  }
}

/** 从 Set-Cookie 中取某个 Cookie 的值。 */
export function cookieValue(setCookie: readonly string[], name: string): string | undefined {
  for (const c of setCookie) {
    const first = c.split(';')[0] ?? '';
    const eq = first.indexOf('=');
    if (eq > 0 && first.slice(0, eq).trim() === name) return decodeURIComponent(first.slice(eq + 1).trim());
  }
  return undefined;
}
