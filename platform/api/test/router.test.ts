import { describe, expect, it } from 'vitest';
import { VirtualClock } from '@atl/workflows';
import type { PlatformPorts } from '@atl/shared';
import { DevAuth, devToken } from '../src/dev/adapters/auth.js';
import { createHttpHandler, json, type RouteHandlers } from '../src/http/router.js';
import type { FunctionDeps } from '../src/runtime/deps.js';
import { loadPlatformEnv } from '../src/runtime/env.js';
import { httpEvent, NO_DB } from './helpers.js';

const clock = new VirtualClock(Date.UTC(2026, 9, 13, 5, 0, 0));
const deps: FunctionDeps = {
  ports: { clock, auth: new DevAuth(clock) } as unknown as PlatformPorts,
  db: NO_DB,
  env: { ...loadPlatformEnv({ ATL_ACCOUNT_ID: '111122223333' }) },
};
const getDeps = async () => deps;
const SID = 's4k7m2q9x1abc';
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

const handlers: RouteHandlers = {
  getMe: async ({ principal }) => json(200, { sub: principal!.sub }),
  createConsoleLink: async () => json(200, { ok: true }),
  createSession: async ({ idempotencyKey, body }) => json(202, { idempotencyKey, body }),
  agentGetContext: async ({ agent }) => json(200, { sid: agent!.sid }),
  internalRunEvents: async ({ internal }) => json(202, { op: internal!.op }),
  reviewManualConfirmation: async () => json(200, {}),
  publicHealth: async () => json(200, { status: 'ok' }),
};

const api = createHttpHandler({ fn: 'atl-api', handlers, getDeps });
const agent = createHttpHandler({ fn: 'atl-agent', handlers, getDeps });
const pub = createHttpHandler({ fn: 'atl-public', handlers, getDeps });
const body = (r: { body?: string }) => JSON.parse(r.body ?? '{}') as Record<string, unknown>;

describe('HTTP router (01 §5.3, §8.1)', () => {
  it('authenticates JWT routes and applies RBAC from the route table', async () => {
    expect((await api(httpEvent('GET', '/api/v1/me'))).statusCode).toBe(401);
    expect(body(await api(httpEvent('GET', '/api/v1/me', { headers: bearer('garbage') }))).code).toBe('UNAUTHENTICATED');
    const ok = await api(httpEvent('GET', '/api/v1/me', { headers: bearer(devToken('observer', 'o1')) }));
    expect(ok.statusCode).toBe(200);
    expect(body(ok)).toEqual({ sub: 'o1' });
    const denied = await api(httpEvent('POST', '/api/v1/sessions/' + SID + '/console-link', { headers: bearer(devToken('assistant', 'a1')) }));
    expect(denied.statusCode).toBe(403);
    expect(denied.headers?.['content-type']).toMatch(/application\/problem\+json/);
    expect(body(denied)).toMatchObject({ code: 'FORBIDDEN_ROLE', status: 403, requestId: 'req-1' });
    expect((await api(httpEvent('POST', `/api/v1/sessions/${SID}/manual-confirmations/c1/review`, { headers: bearer(devToken('learner', 'u1')), body: {} }))).statusCode).toBe(403);
  });

  it('requires a recent login for sensitive routes', async () => {
    const old = Math.floor(clock.nowMs() / 1000) - 2 * 3600;
    const r = await api(httpEvent('POST', `/api/v1/sessions/${SID}/console-link`, { headers: { ...bearer(devToken('learner', 'u1', old)), 'idempotency-key': 'k' } }));
    expect(body(r).code).toBe('REAUTH_REQUIRED');
    const fresh = await api(httpEvent('POST', `/api/v1/sessions/${SID}/console-link`, { headers: { ...bearer(devToken('learner', 'u1')), 'idempotency-key': 'k' } }));
    expect(fresh.statusCode).toBe(200);
  });

  it('requires Idempotency-Key on POST and parses JSON bodies', async () => {
    const h = bearer(devToken('learner', 'u1'));
    expect(body(await api(httpEvent('POST', '/api/v1/sessions', { headers: h, body: { labId: 'svc-ec2' } }))).code).toBe('VALIDATION_FAILED');
    const r = await api(httpEvent('POST', '/api/v1/sessions', { headers: { ...h, 'Idempotency-Key': 'abc' }, body: { labId: 'svc-ec2' } }));
    expect(r.statusCode).toBe(202);
    expect(body(r)).toEqual({ idempotencyKey: 'abc', body: { labId: 'svc-ec2' } });
  });

  it('answers 404 / 405 / 501 for unknown, wrong-method and unimplemented routes', async () => {
    const h = bearer(devToken('learner', 'u1'));
    expect((await api(httpEvent('GET', '/api/v1/nope', { headers: h }))).statusCode).toBe(404);
    expect((await api(httpEvent('PUT', '/api/v1/me', { headers: h }))).statusCode).toBe(405);
    const r = await api(httpEvent('GET', '/api/v1/platform', { headers: h }));
    expect(r.statusCode).toBe(501);
    expect(body(r).code).toBe('NOT_IMPLEMENTED');
    // a route of another function is not served here
    expect((await api(httpEvent('GET', `/api/v1/agent/sessions/${SID}/context`))).statusCode).toBe(404);
  });

  it('agent routes accept only ATLLearnerRole/atl-<sid>-ws of the path sid (SESSION_MISMATCH otherwise)', async () => {
    const ws = `arn:aws:sts::111122223333:assumed-role/ATLLearnerRole/atl-${SID}-ws`;
    expect(body(await agent(httpEvent('GET', `/api/v1/agent/sessions/${SID}/context`, { caller: ws })))).toEqual({ sid: SID });
    for (const caller of [
      `arn:aws:sts::111122223333:assumed-role/ATLLearnerRole/atl-${SID}-console`,
      `arn:aws:sts::111122223333:assumed-role/ATLLearnerRole/atl-s000000000000-ws`,
      `arn:aws:sts::111122223333:assumed-role/ATLWorkstationRole/atl-${SID}-ws`,
      `arn:aws:sts::999999999999:assumed-role/ATLLearnerRole/atl-${SID}-ws`,
      undefined,
    ]) {
      const r = await agent(httpEvent('GET', `/api/v1/agent/sessions/${SID}/context`, caller ? { caller } : {}));
      expect(r.statusCode, String(caller)).toBe(403);
      expect(body(r).code).toBe('SESSION_MISMATCH');
    }
  });

  it('internal routes accept only ATLProvisionerRole/atl-<sid>-prov-* of the run (CALLER_MISMATCH otherwise)', async () => {
    const run = `${SID}-apply-1-0`;
    const prov = `arn:aws:sts::111122223333:assumed-role/ATLProvisionerRole/atl-${SID}-prov-profile-apply`;
    const ok = await agent(httpEvent('POST', `/api/v1/internal/runs/${run}/events`, { caller: prov, headers: { 'idempotency-key': 'k' }, body: {} }));
    expect(body(ok)).toEqual({ op: 'profile-apply' });
    const other = await agent(
      httpEvent('POST', `/api/v1/internal/runs/s000000000000-apply-1-0/events`, { caller: prov, headers: { 'idempotency-key': 'k' }, body: {} }),
    );
    expect(body(other).code).toBe('CALLER_MISMATCH');
    const ws = `arn:aws:sts::111122223333:assumed-role/ATLLearnerRole/atl-${SID}-ws`;
    expect(body(await agent(httpEvent('POST', `/api/v1/internal/runs/${run}/events`, { caller: ws, headers: { 'idempotency-key': 'k' } }))).code).toBe(
      'CALLER_MISMATCH',
    );
  });

  it('public routes need no auth', async () => {
    expect((await pub(httpEvent('GET', '/api/v1/public/health'))).statusCode).toBe(200);
  });
});
