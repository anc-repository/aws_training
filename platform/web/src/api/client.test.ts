import { describe, expect, it, vi } from 'vitest';
import { fakeFetch, json, problem } from '../test/helpers';
import { ApiClient, buildQuery, type TokenSource } from './client';
import { ApiError } from './errors';

function tokens(over: Partial<TokenSource> = {}): TokenSource {
  return { getAccessToken: vi.fn(async () => 'tok-1'), refresh: vi.fn(async () => false), ...over };
}

describe('ApiClient (08 §2.6, 01 §8.1, §7.5)', () => {
  it('builds paths from the @atl/shared route table and sends the bearer token', async () => {
    const f = fakeFetch({ 'GET /api/v1/sessions/s%2F1/events': json(200, { events: [], next: null }) });
    const api = new ApiClient({ tokens: tokens(), fetchImpl: f.impl });
    await api.get('listSessionEvents', { params: { sid: 's/1' }, query: { after: '01ABC', empty: '', none: undefined } });
    expect(f.calls[0]!.url).toBe('/api/v1/sessions/s%2F1/events?after=01ABC');
    expect(f.calls[0]!.headers.authorization).toBe('Bearer tok-1');
    expect(buildQuery({ a: 1, b: null })).toBe('?a=1');
  });

  it('refuses agent / internal routes and missing path parameters', async () => {
    const api = new ApiClient({ tokens: tokens(), fetchImpl: fakeFetch({}).impl });
    await expect(api.call('agentGetContext', { params: { sid: 'x' } })).rejects.toThrow(/not callable from the browser/);
    await expect(api.call('getSession')).rejects.toThrow(/missing path parameter "sid"/);
  });

  it('public routes go without Authorization', async () => {
    const f = fakeFetch({ 'GET /api/v1/public/health': json(200, { status: 'ok' }) });
    const t = tokens();
    await new ApiClient({ tokens: t, fetchImpl: f.impl }).get('publicHealth');
    expect(f.calls[0]!.headers.authorization).toBeUndefined();
    expect(t.getAccessToken).not.toHaveBeenCalled();
  });

  it('every POST carries an Idempotency-Key; an operation reuses the same key across retries', async () => {
    let n = 0;
    const f = fakeFetch({
      'POST /api/v1/sessions': () => (++n === 1 ? problem(503, 'UPSTREAM_UNAVAILABLE') : json(202, { sessionId: 's1' })),
    });
    const api = new ApiClient({ tokens: tokens(), fetchImpl: f.impl });
    const op = api.operation('createSession');
    await expect(op.run({ body: { labId: 'svc-cdn' } })).rejects.toBeInstanceOf(ApiError);
    const r = await op.run({ body: { labId: 'svc-cdn' } });
    expect(r.status).toBe(202);
    expect(f.calls[0]!.headers['idempotency-key']).toBe(op.key);
    expect(f.calls[1]!.headers['idempotency-key']).toBe(op.key);
    // 新的用户操作 → 新键
    await api.call('createSession', { body: {} });
    expect(f.calls[2]!.headers['idempotency-key']).not.toBe(op.key);
    // GET 不带
    expect(f.calls.every((c) => c.method === 'POST')).toBe(true);
  });

  it('session mutations send If-Match: "<ver>"', async () => {
    const f = fakeFetch({ 'POST /api/v1/sessions/s1/end': json(202, {}) });
    await new ApiClient({ tokens: tokens(), fetchImpl: f.impl }).call('endSession', { params: { sid: 's1' }, ifMatch: 7, body: { disposition: 'destroy' } });
    expect(f.calls[0]!.headers['if-match']).toBe('"7"');
  });

  it('conditional GET: stores the ETag, sends If-None-Match and returns the cached body on 304', async () => {
    let n = 0;
    const f = fakeFetch({
      'GET /api/v1/sessions/s1': (c) => (++n === 1 ? json(200, { sessionId: 's1', ver: 3 }, { etag: 'W/"abc"' }) : c.headers['if-none-match'] === 'W/"abc"' ? new Response(null, { status: 304, headers: { etag: 'W/"abc"' } }) : json(500, {})),
    });
    const api = new ApiClient({ tokens: tokens(), fetchImpl: f.impl });
    const a = await api.call<{ ver: number }>('getSession', { params: { sid: 's1' } });
    const b = await api.call<{ ver: number }>('getSession', { params: { sid: 's1' } });
    expect(a.notModified).toBe(false);
    expect(b.notModified).toBe(true);
    expect(b.data).toEqual({ sessionId: 's1', ver: 3 });
    // conditional: false 不带条件头
    await api.call('getSession', { params: { sid: 's1' }, conditional: false }).catch(() => undefined);
    expect(f.calls[2]!.headers['if-none-match']).toBeUndefined();
  });

  it('parses problem+json into ApiError (code, title, detail, requestId, Retry-After)', async () => {
    const f = fakeFetch({
      'POST /api/v1/sessions/s1/extend': problem(409, 'EXTENSION_LIMIT', { detail: 'no extensions left' }),
      'POST /api/v1/sessions/s1/heartbeat': problem(429, 'RATE_LIMITED', {}, { 'retry-after': '12' }),
      'GET /api/v1/time': problem(503, 'UPSTREAM_THROTTLED'),
    });
    const api = new ApiClient({ tokens: tokens(), fetchImpl: f.impl });
    const e1 = (await api.call('extendSession', { params: { sid: 's1' } }).catch((e: unknown) => e)) as ApiError;
    expect(e1).toBeInstanceOf(ApiError);
    expect([e1.status, e1.code, e1.detail, e1.requestId]).toEqual([409, 'EXTENSION_LIMIT', 'no extensions left', 'req-1']);
    expect(e1.isTransient).toBe(false);
    const e2 = (await api.call('heartbeat', { params: { sid: 's1' } }).catch((e: unknown) => e)) as ApiError;
    expect(e2.retryAfterSec).toBe(12);
    const e3 = (await api.call('getTime').catch((e: unknown) => e)) as ApiError;
    expect(e3.retryAfterSec).toBe(30);
    expect(e3.isTransient).toBe(true);
  });

  it('401: refreshes once and retries; when the refresh fails, reports onUnauthenticated', async () => {
    let tok = 'old';
    const f = fakeFetch({ 'GET /api/v1/me': (c) => (c.headers.authorization === 'Bearer new' ? json(200, { sub: 'u1' }) : problem(401, 'UNAUTHENTICATED')) });
    const t = tokens({ getAccessToken: vi.fn(async () => tok), refresh: vi.fn(async () => ((tok = 'new'), true)) });
    const onUnauthenticated = vi.fn();
    const api = new ApiClient({ tokens: t, fetchImpl: f.impl, hooks: { onUnauthenticated } });
    expect(await api.get('getMe')).toEqual({ sub: 'u1' });
    expect(t.refresh).toHaveBeenCalledTimes(1);
    expect(onUnauthenticated).not.toHaveBeenCalled();

    const t2 = tokens({ refresh: vi.fn(async () => false) });
    const f2 = fakeFetch({ 'GET /api/v1/me': problem(401, 'UNAUTHENTICATED') });
    const api2 = new ApiClient({ tokens: t2, fetchImpl: f2.impl, hooks: { onUnauthenticated } });
    await expect(api2.get('getMe')).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(onUnauthenticated).toHaveBeenCalledTimes(1);
    expect(f2.calls).toHaveLength(1);
  });

  it('403 REAUTH_REQUIRED hands the pending request (with its Idempotency-Key) to onReauthRequired', async () => {
    const f = fakeFetch({ 'POST /api/v1/sessions/s1/terminals': problem(403, 'REAUTH_REQUIRED') });
    const onReauthRequired = vi.fn();
    const api = new ApiClient({ tokens: tokens(), fetchImpl: f.impl, hooks: { onReauthRequired } });
    await expect(api.call('createTerminal', { params: { sid: 's1' }, body: { target: 'lab' } })).rejects.toMatchObject({ code: 'REAUTH_REQUIRED' });
    const [, pending] = onReauthRequired.mock.calls[0]!;
    expect(pending.routeId).toBe('createTerminal');
    expect(pending.opts.idempotencyKey).toBe(f.calls[0]!.headers['idempotency-key']);
    // 重放用同一个键
    await api.replay(pending).catch(() => undefined);
    expect(f.calls[1]!.headers['idempotency-key']).toBe(f.calls[0]!.headers['idempotency-key']);
  });

  it('network errors and 5xx are reported as transient; success resets', async () => {
    const onTransientFailure = vi.fn();
    const onSuccess = vi.fn();
    const failing = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    const api = new ApiClient({ tokens: tokens(), fetchImpl: failing, hooks: { onTransientFailure, onSuccess } });
    await expect(api.get('getTime')).rejects.toMatchObject({ code: 'NETWORK', isNetwork: true });
    expect(onTransientFailure).toHaveBeenCalledTimes(1);
    const ok = new ApiClient({ tokens: tokens(), fetchImpl: fakeFetch({ 'GET /api/v1/time': json(200, { serverNow: 'x' }) }).impl, hooks: { onTransientFailure, onSuccess } });
    await ok.get('getTime');
    expect(onSuccess).toHaveBeenCalled();
  });

  it('204 returns null data (GET /sessions/current without a session)', async () => {
    const f = fakeFetch({ 'GET /api/v1/sessions/current': new Response(null, { status: 204 }) });
    const r = await new ApiClient({ tokens: tokens(), fetchImpl: f.impl }).call('getCurrentSession');
    expect([r.status, r.data]).toEqual([204, null]);
  });
});
