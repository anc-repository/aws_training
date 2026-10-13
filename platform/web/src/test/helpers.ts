/** 测试工具：可编排的 fetch 假实现（按“方法 路径”匹配，记录每次调用）。 */
import { vi } from 'vitest';

export interface FakeCall {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

export type FakeResponder = (call: FakeCall) => Response | Promise<Response>;

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  const init: ResponseInit = { status, headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json', ...headers } };
  return new Response(status === 204 || status === 304 ? null : JSON.stringify(body), init);
}

export function problem(status: number, code: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}): Response {
  return json(status, { type: `urn:atl:error:${code}`, title: code, status, code, requestId: 'req-1', ...extra }, headers);
}

/** routes：键为 “GET /api/v1/time” 这样的字符串（路径不含查询串）或带 * 的前缀。 */
export function fakeFetch(routes: Record<string, FakeResponder | Response>) {
  const calls: FakeCall[] = [];
  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = {};
    const h = init?.headers;
    if (h && typeof h === 'object' && !(h instanceof Headers) && !Array.isArray(h)) for (const [k, v] of Object.entries(h)) headers[k.toLowerCase()] = String(v);
    let body: unknown = undefined;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    const call = { method, url, headers, body };
    calls.push(call);
    const path = url.split('?')[0];
    const key = `${method} ${path}`;
    const hit = routes[key] ?? Object.entries(routes).find(([k]) => k.endsWith('*') && key.startsWith(k.slice(0, -1)))?.[1];
    if (!hit) return json(404, { type: 'x', title: 'not found', status: 404, code: 'NOT_FOUND' });
    const r = typeof hit === 'function' ? await hit(call) : hit.clone();
    return r;
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

/** 生成测试用的 ULID 形状 id（单调）。 */
export function ulid(n: number): string {
  return `01J${String(n).padStart(23, '0')}`;
}
