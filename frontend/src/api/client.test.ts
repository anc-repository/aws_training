import { describe, expect, it, vi } from 'vitest';
import { HEADERS } from '@cloudalbum/contracts';
import { jsonResponse } from '../test/helpers';
import { getTraceSnapshot, routeTemplate } from '../trace/TraceStore';
import { api, apiFetch, ApiError, buildUrl, setBearerTokenProvider } from './client';

describe('api/client', () => {
  it('把 Server-Timing、X-CloudAlbum-Path、请求 ID 写入 TraceStore', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({ items: [] }, {
      headers: {
        [HEADERS.serverTiming]: 'total;dur=48.7, database;dur=21.3;desc="postgres@rds x3", cache;dur=1.2;desc="redis@elasticache:miss"',
        [HEADERS.path]: 'entry=cloudfront>alb>nginx;inst=i-0abc;az=ap-northeast-1c;auth=cognito:sdk;database=postgres@rds;cache=redis@elasticache:miss',
        [HEADERS.requestId]: '01JA3K9V7Q4M2X8N5B6C0D1E2F',
      },
    })) as typeof fetch;
    await api('/api/feed');
    const [e] = getTraceSnapshot().entries;
    expect(e).toBeDefined();
    expect(e!.method).toBe('GET');
    expect(e!.route).toBe('/api/feed');
    expect(e!.status).toBe(200);
    expect(e!.requestId).toBe('01JA3K9V7Q4M2X8N5B6C0D1E2F');
    expect(e!.serverTiming.find((m) => m.name === 'database')).toMatchObject({ dur: 21.3, desc: 'postgres@rds x3' });
    expect(e!.path.entry).toBe('cloudfront>alb>nginx');
    expect(e!.path.modules.map((m) => m.module)).toEqual(['auth', 'database', 'cache']);
    expect(getTraceSnapshot().latestPath?.inst).toBe('i-0abc');
  });

  it('旁路与实验头只在要求时发送，响应的 X-CloudAlbum-Bypass 被记录', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const h = new Headers(init?.headers);
      expect(h.get(HEADERS.compareBypass)).toBe('cache');
      expect(h.get(HEADERS.experimentRun)).toBe('run1');
      return jsonResponse({}, { headers: { [HEADERS.bypass]: 'cache', [HEADERS.path]: 'entry=nginx;cache=redis@elasticache:bypass;bypass=cache' } });
    });
    globalThis.fetch = fetchMock as typeof fetch;
    await api('/api/feed', { bypass: ['cache'], experiment: { run: 'run1', label: 'after' }, traceLabel: 'B' });
    const [e] = getTraceSnapshot().entries;
    expect(e!.bypassed).toEqual(['cache']);
    expect(e!.requestedBypass).toEqual(['cache']);
    expect(e!.label).toBe('B');
    expect(e!.path.bypass).toEqual(['cache']);
  });

  it('401 时单飞刷新会话并重试一次', async () => {
    let authed = false;
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url);
      calls.push(`${init?.method ?? 'GET'} ${u}`);
      if (u === '/api/auth/refresh') {
        authed = true;
        return new Response(null, { status: 204 });
      }
      return authed ? jsonResponse({ id: 'u1' }) : jsonResponse({ error: 'UNAUTHENTICATED' }, { status: 401 });
    }) as typeof fetch;
    await expect(api<{ id: string }>('/api/me')).resolves.toEqual({ id: 'u1' });
    expect(calls).toEqual(['GET /api/me', 'POST /api/auth/refresh', 'GET /api/me']);
  });

  it('非 2xx 抛 ApiError（含错误码、消息与请求 ID）；501 标记为未实现', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({ error: 'NOT_IMPLEMENTED', message: 'albums 路由尚未实现' }, { status: 501, headers: { [HEADERS.requestId]: 'r1' } })) as typeof fetch;
    const e = await api('/api/albums').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect((e as ApiError).code).toBe('NOT_IMPLEMENTED');
    expect((e as ApiError).notImplemented).toBe(true);
    expect((e as ApiError).requestId).toBe('r1');
  });

  it('网络错误也记入路径追踪（状态 0）', async () => {
    globalThis.fetch = vi.fn(async () => { throw new TypeError('Failed to fetch'); }) as typeof fetch;
    await expect(apiFetch('/api/feed')).rejects.toThrow('Failed to fetch');
    expect(getTraceSnapshot().entries[0]).toMatchObject({ status: 0, error: 'Failed to fetch' });
  });

  it('Amplify 变体：附带 Bearer 令牌，不走 Cookie 刷新', async () => {
    setBearerTokenProvider(async () => 'tok');
    try {
      globalThis.fetch = vi.fn(async (_u: RequestInfo | URL, init?: RequestInit) => {
        expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer tok');
        return jsonResponse({ ok: true });
      }) as typeof fetch;
      await api('/api/me');
    } finally {
      setBearerTokenProvider(null);
    }
  });

  it('buildUrl / routeTemplate', () => {
    expect(buildUrl('/api/feed', { cursor: 'abc', x: undefined, y: '' })).toBe('/api/feed?cursor=abc');
    expect(buildUrl('/social/x', {}, 'https://abc.execute-api.ap-northeast-1.amazonaws.com/')).toBe('https://abc.execute-api.ap-northeast-1.amazonaws.com/social/x');
    expect(routeTemplate('/api/photos/0f8c8d1e-1234-4abc-8def-0123456789ab/complete?x=1')).toBe('/api/photos/:id/complete');
    expect(routeTemplate('http://h/social/shares/01JA3K9V7Q4M2X8N5B6C0D1E2F')).toBe('/social/shares/:id');
  });
});
