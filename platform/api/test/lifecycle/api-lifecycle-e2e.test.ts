/**
 * atl-api routes against the real atl-lifecycle, state machines and simulator (platform-integration): the API's session
 * flows end to end — start, keep now (T11 → KEPT), keep extension (T13), release, keep at expiry (the API's object-form
 * preferredDisposition), cancel while REQUESTED / PROVISIONING, and a platform action through atl-module-op. The API unit
 * tests replace atl-lifecycle by a dev fallback; this file pins the contract between the two.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ExecutionNames, Keys, WebKeys, type PlatformPorts } from '@atl/shared';
import { DevAuth } from '../../src/dev/adapters/auth.js';
import { devPlatformConfig } from '../../src/dev/create-tables.js';
import type { HttpEvent, HttpResult } from '../../src/http/types.js';
import { createApiHttpHandler } from '../../src/routes/index.js';
import type { FunctionDeps } from '../../src/runtime/deps.js';
import { clearContentCache } from '../../src/services/catalog/store.js';
import { CATALOG_VERSION, fixtureIndex, fixtureLab, fixtureQuiz, LAB_ID } from '../api-support/fixtures.js';
import { createHarness, SUB, type Harness } from './support/harness.js';

let h: Harness;
afterEach(async () => {
  await h?.close();
});

const TOKEN = `dev.learner.${SUB}`;
let n = 0;

function ev(method: string, path: string, body?: unknown): HttpEvent {
  return {
    version: '2.0',
    rawPath: path.split('?')[0]!,
    rawQueryString: path.split('?')[1] ?? '',
    headers: { authorization: `Bearer ${TOKEN}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(method === 'POST' ? { 'idempotency-key': `k-${++n}-${Math.random().toString(36).slice(2)}` } : {}) },
    queryStringParameters: Object.fromEntries(new URLSearchParams(path.split('?')[1] ?? '').entries()),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    isBase64Encoded: false,
    requestContext: { requestId: `r-${n}`, http: { method, path: path.split('?')[0]!, sourceIp: '127.0.0.1', userAgent: 'vitest' } },
  } as HttpEvent;
}

async function setup() {
  h = await createHarness();
  clearContentCache();
  const nowIso = new Date(h.clock.nowMs()).toISOString();
  await h.deps.db.send(new (await import('@aws-sdk/lib-dynamodb')).PutCommand({ TableName: h.env.tableName, Item: { ...devPlatformConfig(nowIso, 'ap-northeast-1', '000000000000', 8787), platformUrl: 'https://d1.cloudfront.net', agentApiEndpoint: 'https://abc123.execute-api.ap-northeast-1.amazonaws.com' } }));
  const web = h.env.buckets.web;
  const prefix = WebKeys.content(CATALOG_VERSION);
  await h.objects.put(web, `${prefix}labs/${LAB_ID}.json`, JSON.stringify(fixtureLab()));
  await h.objects.put(web, `${prefix}catalog/index.json`, JSON.stringify(fixtureIndex()));
  await h.objects.put(web, `${prefix}profiles/atl/${LAB_ID}/default.env`, 'PROFILE_NAME=atl/svc-queue/default\nPROFILE_PLAN_DIGEST=sha256:aaaa\n');
  await h.objects.put(h.env.buckets.artifacts, `releases/${CATALOG_VERSION}/private/quiz/${LAB_ID}.json`, JSON.stringify(fixtureQuiz()));
  const { PutCommand } = await import('@aws-sdk/lib-dynamodb');
  for (const item of [
    { ...Keys.catalogRelease(CATALOG_VERSION), type: 'CatalogRelease', ver: 1, createdAt: nowIso, updatedAt: nowIso, catalogVersion: CATALOG_VERSION, contentDigest: 'sha256:test' },
    { ...Keys.catalogCurrent(), type: 'CatalogRelease', ver: 1, createdAt: nowIso, updatedAt: nowIso, catalogVersion: CATALOG_VERSION },
  ]) {
    await h.deps.db.send(new PutCommand({ TableName: h.env.tableName, Item: item }));
  }
  const apiDeps: FunctionDeps = { ...h.deps, ports: { ...h.deps.ports, auth: new DevAuth(h.clock) } as PlatformPorts };
  const api = createApiHttpHandler(async () => apiDeps);
  const call = async (method: string, path: string, body?: unknown) => {
    const r = (await api(ev(method, path, body))) as HttpResult;
    return { status: r.statusCode, body: (r.body ? JSON.parse(r.body) : {}) as Record<string, unknown> };
  };
  return { call };
}

async function startReady(call: Awaited<ReturnType<typeof setup>>['call']): Promise<string> {
  const q = await call('POST', `/api/v1/labs/${LAB_ID}/quotes`, { purpose: 'START' });
  expect(q.status, JSON.stringify(q.body)).toBe(201);
  const s = await call('POST', '/api/v1/sessions', { labId: LAB_ID, quoteId: q.body.quoteId, costAcknowledged: true });
  expect(s.status, JSON.stringify(s.body)).toBe(202);
  const sid = String(s.body.sessionId);
  expect((await h.waitExecution('atl-session-start', ExecutionNames.start(sid))).status).toBe('SUCCEEDED');
  const hb = await call('POST', `/api/v1/sessions/${sid}/heartbeat`, { workbench: true });
  expect(hb.body.state).toBe('RUNNING');
  return sid;
}

describe('atl-api × atl-lifecycle (real workflows)', () => {
  it('keep now → KEPT, keep extension, release → ENDED', async () => {
    const { call } = await setup();
    const sid = await startReady(call);
    const kq = await call('POST', `/api/v1/sessions/${sid}/quotes`, { purpose: 'KEEP', keepHours: 4 });
    expect(kq.status, JSON.stringify(kq.body)).toBeLessThan(300);
    const end = await call('POST', `/api/v1/sessions/${sid}/end`, { disposition: 'keep', keepHours: 4, quoteId: kq.body.quoteId, when: 'now' });
    expect(end.status, JSON.stringify(end.body)).toBe(202);
    expect((await h.waitExecution('atl-session-end', ExecutionNames.endFirst(sid))).status).toBe('SUCCEEDED');
    let s = await h.session(sid);
    expect(s.state).toBe('KEPT');
    expect(s.keep).toMatchObject({ version: 1 });
    const kq2 = await call('POST', `/api/v1/sessions/${sid}/quotes`, { purpose: 'KEEP', keepHours: 2 });
    const ext = await call('POST', `/api/v1/sessions/${sid}/keep/extend`, { hours: 2, quoteId: kq2.body.quoteId });
    expect(ext.status, JSON.stringify(ext.body)).toBe(200);
    expect((await h.session(sid)).keep).toMatchObject({ version: 2 });
    const rel = await call('POST', `/api/v1/sessions/${sid}/keep/release`);
    expect(rel.status, JSON.stringify(rel.body)).toBe(202);
    await h.waitExecution('atl-session-end', ExecutionNames.endRelease(sid));
    s = await h.session(sid);
    expect(s.state).toBe('ENDED');
  }, 60_000);

  it('keep chosen for the expiry (POST /end when=at-expiry) → the expiry keeps the environment', async () => {
    const { call } = await setup();
    const sid = await startReady(call);
    const kq = await call('POST', `/api/v1/sessions/${sid}/quotes`, { purpose: 'KEEP', keepHours: 4 });
    const pref = await call('POST', `/api/v1/sessions/${sid}/end`, { disposition: 'keep', keepHours: 4, quoteId: kq.body.quoteId, when: 'at-expiry' });
    expect(pref.status, JSON.stringify(pref.body)).toBeLessThan(300);
    await h.until(async () => (await h.session(sid)).state === 'KEPT', 6 * 3_600_000, 5 * 60_000);
    const s = await h.session(sid);
    expect(s.endReason).toBe('EXPIRED');
    expect(s.keep?.until).toBeTruthy();
  }, 60_000);

  it('a platform action through atl-module-op, then destroy', async () => {
    const { call } = await setup();
    const sid = await startReady(call);
    const op = await call('POST', `/api/v1/sessions/${sid}/module-ops`, { actionId: 'queue-purge' });
    expect(op.status, JSON.stringify(op.body)).toBe(202);
    const execs = h.sim.listExecutions().filter((e) => e.stateMachine === 'atl-module-op');
    expect(execs).toHaveLength(1);
    const d = await h.sim.waitFor(execs[0]!.executionArn);
    expect(d.status, JSON.stringify(d.output ?? d.error)).toBe('SUCCEEDED');
    expect(h.runner.ops().some((o) => o.startsWith('module-op:'))).toBe(true);
    const end = await call('POST', `/api/v1/sessions/${sid}/end`, { disposition: 'destroy', when: 'now' });
    expect(end.status).toBe(202);
    await h.waitExecution('atl-session-end', ExecutionNames.endFirst(sid));
    expect((await h.session(sid)).state).toBe('ENDED');
  }, 60_000);

  it('cancel while PROVISIONING (T06) through POST /end', async () => {
    const { call } = await setup();
    const q = await call('POST', `/api/v1/labs/${LAB_ID}/quotes`, { purpose: 'START' });
    const s = await call('POST', '/api/v1/sessions', { labId: LAB_ID, quoteId: q.body.quoteId, costAcknowledged: true });
    const sid = String(s.body.sessionId);
    await h.until(async () => (await h.session(sid)).state === 'PROVISIONING', 3_600_000, 1000);
    const end = await call('POST', `/api/v1/sessions/${sid}/end`, { disposition: 'destroy' });
    expect(end.status, JSON.stringify(end.body)).toBe(202);
    await h.until(async () => ['ENDED', 'FAILED', 'CLEANUP_FAILED'].includes((await h.session(sid)).state), 6 * 3_600_000, 60_000);
    const after = await h.session(sid);
    expect(after.state).toBe('ENDED');
    expect(after.endReason).toBe('CANCELLED');
  }, 60_000);
});
