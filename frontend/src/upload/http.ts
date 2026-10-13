// 上传用的 PUT：用 XMLHttpRequest 以便显示上传进度（fetch 拿不到上传进度）。
// 同源 PUT（local 驱动的 /api/storage/upload）的响应带路径头，照样写入 TraceStore；跨域到 S3 的预签名 PUT 没有这些头。
import { HEADERS, parseServerTiming } from '@cloudalbum/contracts';
import { recordTrace } from '../trace/TraceStore';

export interface PutResult {
  status: number;
  etag?: string;
  responseText: string;
}

export interface PutOptions {
  headers?: Record<string, string>;
  onProgress?: (loaded: number, total: number) => void;
  signal?: AbortSignal;
}

export type PutImpl = (url: string, body: Blob, opts: PutOptions) => Promise<PutResult>;

function absolute(url: string): string {
  try {
    return new URL(url, globalThis.location?.href ?? 'http://localhost/').href;
  } catch {
    return url;
  }
}

export const xhrPut: PutImpl = (url, body, opts) =>
  new Promise<PutResult>((resolve, reject) => {
    const XHR = globalThis.XMLHttpRequest;
    if (typeof XHR !== 'function' || (globalThis as { __CLOUDALBUM_MOCK__?: string }).__CLOUDALBUM_MOCK__) {
      // 没有 XHR 的环境（测试、Worker）与开发用模拟后端（它只包装 fetch）退回 fetch
      void fetchPut(url, body, opts).then(resolve, reject);
      return;
    }
    const xhr = new XHR();
    const start = globalThis.performance?.now?.() ?? Date.now();
    xhr.open('PUT', url, true);
    for (const [k, v] of Object.entries(opts.headers ?? {})) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) opts.onProgress?.(e.loaded, e.total);
    };
    const onAbort = () => xhr.abort();
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    xhr.onload = () => {
      opts.signal?.removeEventListener('abort', onAbort);
      const pathRaw = safeHeader(xhr, HEADERS.path);
      recordTrace({
        startTime: start,
        method: 'PUT',
        url: absolute(url),
        status: xhr.status,
        durationMs: (globalThis.performance?.now?.() ?? Date.now()) - start,
        serverTiming: parseServerTiming(safeHeader(xhr, HEADERS.serverTiming)),
        pathRaw,
        ...(safeHeader(xhr, HEADERS.requestId) ? { requestId: safeHeader(xhr, HEADERS.requestId) } : {}),
      });
      const etag = safeHeader(xhr, 'ETag');
      resolve({ status: xhr.status, responseText: xhr.responseText ?? '', ...(etag ? { etag } : {}) });
    };
    xhr.onerror = () => reject(new Error('上传请求失败（网络错误或被 CORS 拒绝）'));
    xhr.onabort = () => reject(new DOMException('上传已取消', 'AbortError'));
    xhr.send(body);
  });

function safeHeader(xhr: XMLHttpRequest, name: string): string {
  try {
    return xhr.getResponseHeader(name) ?? '';
  } catch {
    return '';
  }
}

export const fetchPut: PutImpl = async (url, body, opts) => {
  const init: RequestInit = { method: 'PUT', body };
  if (opts.headers) init.headers = opts.headers;
  if (opts.signal) init.signal = opts.signal;
  const start = globalThis.performance?.now?.() ?? Date.now();
  const res = await globalThis.fetch(url, init);
  recordTrace({
    startTime: start,
    method: 'PUT',
    url: absolute(url),
    status: res.status,
    durationMs: (globalThis.performance?.now?.() ?? Date.now()) - start,
    serverTiming: parseServerTiming(res.headers.get(HEADERS.serverTiming)),
    pathRaw: res.headers.get(HEADERS.path) ?? '',
  });
  opts.onProgress?.(body.size, body.size);
  const etag = res.headers.get('ETag') ?? undefined;
  return { status: res.status, responseText: await res.text(), ...(etag ? { etag } : {}) };
};

export class UploadHttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'UploadHttpError';
    this.status = status;
  }
}

export function ensureOk(r: PutResult, what: string): void {
  if (r.status >= 200 && r.status < 300) return;
  let msg = `${what}失败（HTTP ${r.status}）`;
  try {
    const body = JSON.parse(r.responseText) as { message?: string; error?: string };
    if (body.message || body.error) msg += `：${body.message ?? body.error}`;
  } catch {
    /* S3 返回 XML，原样忽略 */
  }
  throw new UploadHttpError(r.status, msg);
}
