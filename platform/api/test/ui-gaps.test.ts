/**
 * 08 §9.2 routes implemented by the definition of 08 (`pending01` in the route table) and the refinements of registered
 * routes (routes/gaps.ts).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { DataKeys, Gsi2, Keys, newUlid, ROUTES, runnerRunId, SESSION_PHASE_NAMES, UI_REQUESTED_ROUTES } from '@atl/shared';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { devAdvance } from '../src/dev-server.js';
import { ASSISTANT, body, createApiTestRuntime, ev, LEARNER, OBSERVER, T0, type ApiTestRuntime } from './api-support/api-runtime.js';
import { CATALOG_VERSION, fixtureLab, LAB_ID } from './api-support/fixtures.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

async function ready(rt: ApiTestRuntime): Promise<{ sid: string; envId: string }> {
  const q = body(await rt.api(ev('POST', `/api/v1/labs/${LAB_ID}/quotes`, { token: LEARNER, body: { purpose: 'START' } })));
  const sid = body(await rt.api(ev('POST', '/api/v1/sessions', { token: LEARNER, body: { labId: LAB_ID, quoteId: q.quoteId, costAcknowledged: true } }))).sessionId as string;
  await devAdvance(rt.deps, sid, 'PROVISIONING');
  const s = await devAdvance(rt.deps, sid, 'READY');
  return { sid, envId: String(s.envId) };
}

const iso = (ms: number) => new Date(ms).toISOString();

describe('route table', () => {
  it('08 routes carry pending01; the rest of the requests stay out of ROUTES', () => {
    const pending = ROUTES.filter((r) => r.pending01).map((r) => r.id);
    expect(pending.sort()).toEqual(['getCheckEvidence', 'getPlatformExport', 'getRunnerRunLog', 'listEnvironmentResources', 'listManualConfirmations', 'listRunnerRuns', 'openStepOutage']);
    expect(UI_REQUESTED_ROUTES.map((r) => r.ref)).toEqual(['08 §9.2 #5', '08 §9.2 #14', '08 §9.2 #29']);
  });

  it('atl-lifecycle only writes phase names of the 08 §9.2 #8 table', () => {
    const dir = path.resolve(HERE, '../src/functions/lifecycle');
    const used = new Set<string>();
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.ts'))) {
      for (const m of fs.readFileSync(path.join(dir, f), 'utf8').matchAll(/phase: '((?:start|provision|end|clean)\.[a-z-]+)'/g)) used.add(m[1]!);
    }
    expect(used.size).toBeGreaterThan(15);
    for (const p of used) expect(SESSION_PHASE_NAMES as readonly string[], p).toContain(p);
  });
});

describe('08 §9.2 routes', () => {
  let rt: ApiTestRuntime;
  beforeEach(async () => {
    rt = await createApiTestRuntime();
  });

  it('#3 GET /platform: complete account ID for the learner only', async () => {
    expect(body(await rt.api(ev('GET', '/api/v1/platform', { token: LEARNER })))).toMatchObject({ accountId: '111122223333', accountIdMasked: false });
    expect(body(await rt.api(ev('GET', '/api/v1/platform', { token: OBSERVER })))).toMatchObject({ accountId: '••••3333', accountIdMasked: true });
  });

  it('#11 runner runs: list, and the log with secrets and account IDs removed', async () => {
    const { sid } = await ready(rt);
    const runId = runnerRunId(sid, 'base-deploy', 1);
    await rt.repos.sessions.putChild({ ...Keys.runnerRun(sid, runId), type: 'RunnerRun', ver: 1, createdAt: iso(T0), updatedAt: iso(T0), runId, sessionId: sid, op: 'base-deploy', status: 'SUCCEEDED', resultKey: DataKeys.runResult(runId) });
    await rt.objects.put(rt.deps.env.buckets.data, DataKeys.runResult(runId), JSON.stringify({ ok: true, stackArn: 'arn:aws:cloudformation:ap-northeast-1:111122223333:stack/cloudalbum-e1-ec2/x', password: 'hunter2' }));
    await rt.objects.put(rt.deps.env.buckets.data, `${DataKeys.run(runId)}progress.jsonl`, `${JSON.stringify({ status: 'STARTED', op: 'base-deploy' })}\nnot json for 111122223333\n`);
    const list = body(await rt.api(ev('GET', `/api/v1/sessions/${sid}/runner-runs`, { token: OBSERVER })));
    expect(list.items).toEqual([expect.objectContaining({ runId, op: 'base-deploy', status: 'SUCCEEDED' })]);
    expect(JSON.stringify(list)).not.toContain('resultKey');
    const log = await rt.api(ev('GET', `/api/v1/sessions/${sid}/runner-runs/${runId}/log`, { token: ASSISTANT }));
    expect(log.statusCode, log.body).toBe(200);
    const b = body(log);
    expect(b).toMatchObject({ runId, op: 'base-deploy', status: 'SUCCEEDED', progress: [{ status: 'STARTED' }, { text: 'not json for ********3333' }] });
    expect(JSON.stringify(b)).not.toContain('hunter2');
    expect(JSON.stringify(b)).not.toContain('111122223333');
    expect((await rt.api(ev('GET', `/api/v1/sessions/${sid}/runner-runs/${runId}/log`, { token: OBSERVER }))).statusCode).toBe(403);
    expect((await rt.api(ev('GET', `/api/v1/sessions/${sid}/runner-runs/s0000000000aa-bd-1/log`, { token: LEARNER }))).statusCode).toBe(404);
  });

  it('#12 report: versions, a given version, view=full returns the stored JSON as is', async () => {
    const { sid } = await ready(rt);
    for (const v of [1, 2]) {
      const key = `reports/${sid}/report-v${v}.json`;
      await rt.objects.put(rt.deps.env.buckets.data, key, `{"schema":"atl.report/v1","v":${v}}`);
      await rt.repos.sessions.putChild({ ...Keys.report(sid, v), type: 'Report', ver: 1, createdAt: iso(T0), updatedAt: iso(T0), version: v, digest: `sha256:${v}`, generatedAt: iso(T0 + v), s3Keys: { json: key, html: `reports/${sid}/report-v${v}.html` } });
    }
    const latest = body(await rt.api(ev('GET', `/api/v1/sessions/${sid}/report`, { token: LEARNER })));
    expect(latest).toMatchObject({ version: 2, versions: [{ version: 2 }, { version: 1 }] });
    const v1 = body(await rt.api(ev('GET', `/api/v1/sessions/${sid}/report?version=1`, { token: OBSERVER })));
    expect(v1).toMatchObject({ version: 1, latest: false, downloads: { json: { url: expect.stringContaining('report-v1.json') } } });
    const full = await rt.api(ev('GET', `/api/v1/sessions/${sid}/report?version=1&view=full`, { token: LEARNER }));
    expect(full.statusCode).toBe(200);
    expect(full.body).toBe('{"schema":"atl.report/v1","v":1}');
    expect(full.headers).toMatchObject({ 'x-atl-report-version': '1', 'x-atl-report-digest': 'sha256:1' });
    expect((await rt.api(ev('GET', `/api/v1/sessions/${sid}/report?version=9`, { token: LEARNER }))).statusCode).toBe(404);
    expect((await rt.api(ev('GET', `/api/v1/sessions/${sid}/report?view=raw`, { token: LEARNER }))).statusCode).toBe(400);
  });

  it('#13 evidence: inline, stored in atl-data/evidence (same origin), foreign keys refused', async () => {
    const { sid } = await ready(rt);
    const runId = newUlid(T0);
    const stored = DataKeys.evidence(sid, runId, 'queue-cap');
    await rt.objects.put(rt.deps.env.buckets.data, stored, JSON.stringify({ schema: 'atl.evidence/v1', big: 'x'.repeat(5000) }));
    await rt.repos.sessions.putChild({
      ...Keys.checkRun(sid, runId),
      type: 'CheckRun',
      ver: 1,
      createdAt: iso(T0),
      updatedAt: iso(T0),
      runId,
      results: [
        { checkKey: 'queue-cap', evidence: null, evidenceKey: stored, evidenceDigest: 'sha256:big' },
        { checkKey: 'small', evidence: { schema: 'atl.evidence/v1', ok: true }, evidenceDigest: 'sha256:s' },
        { checkKey: 'evil', evidence: null, evidenceKey: 'reports/other/report.json', evidenceDigest: 'sha256:e' },
      ],
    });
    const big = await rt.api(ev('GET', `/api/v1/sessions/${sid}/check-runs/${runId}/evidence/queue-cap`, { token: OBSERVER }));
    expect(big.statusCode, big.body).toBe(200);
    expect(body(big)).toMatchObject({ stored: true, digest: 'sha256:big', evidence: { schema: 'atl.evidence/v1' } });
    expect(body(await rt.api(ev('GET', `/api/v1/sessions/${sid}/check-runs/${runId}/evidence/small`, { token: LEARNER })))).toMatchObject({ stored: false, evidence: { ok: true } });
    expect((await rt.api(ev('GET', `/api/v1/sessions/${sid}/check-runs/${runId}/evidence/evil`, { token: LEARNER }))).statusCode).toBe(404);
    expect((await rt.api(ev('GET', `/api/v1/sessions/${sid}/check-runs/${runId}/evidence/missing`, { token: LEARNER }))).statusCode).toBe(404);
  });

  it('#16 export status: pending until the archive exists, then a download link', async () => {
    const id = 'a'.repeat(26);
    expect(body(await rt.api(ev('GET', `/api/v1/platform/exports/${id}`, { token: LEARNER })))).toMatchObject({ exportId: id, status: 'pending' });
    await rt.objects.put(rt.deps.env.buckets.data, `exports/${id}.zip`, 'zip');
    expect(body(await rt.api(ev('GET', `/api/v1/platform/exports/${id}`, { token: LEARNER })))).toMatchObject({ status: 'ready', downloadUrl: expect.stringContaining(`exports/${id}.zip`) });
    expect((await rt.api(ev('GET', `/api/v1/platform/exports/${id}`, { token: ASSISTANT }))).statusCode).toBe(403);
    expect((await rt.api(ev('GET', '/api/v1/platform/exports/nope', { token: LEARNER }))).statusCode).toBe(404);
  });

  it('#18 assistant review queue (REVIEW#PENDING)', async () => {
    const { sid } = await ready(rt);
    const cid = newUlid(T0);
    await rt.repos.sessions.putChild({ ...Keys.manualConfirmation(sid, 'dlq', 'dlq-ok', cid), ...Gsi2.manualConfirmation(true, iso(T0), sid)!, type: 'ManualConfirmation', ver: 1, createdAt: iso(T0), updatedAt: iso(T0), confirmationId: cid, sessionId: sid, stepId: 'dlq', checkId: 'dlq-ok', status: 'PENDING' });
    const q = body(await rt.api(ev('GET', '/api/v1/manual-confirmations?status=pending', { token: ASSISTANT })));
    expect(q.items).toEqual([expect.objectContaining({ confirmationId: cid, sessionId: sid, stepId: 'dlq', labId: LAB_ID, sessionState: 'READY' })]);
    expect(JSON.stringify(q)).not.toContain('GSI2PK');
    expect((await rt.api(ev('GET', '/api/v1/manual-confirmations', { token: LEARNER }))).statusCode).toBe(403);
    expect((await rt.api(ev('GET', '/api/v1/manual-confirmations?status=approved', { token: ASSISTANT }))).statusCode).toBe(400);
  });

  it('#22 a cursor from the future (or before the session) is 410 CURSOR_EXPIRED; a good one still works', async () => {
    const { sid } = await ready(rt);
    const future = newUlid(T0 + 3_600_000);
    const r = await rt.api(ev('GET', `/api/v1/sessions/${sid}/events?after=${future}`, { token: LEARNER }));
    expect(body(r)).toMatchObject({ status: 410, code: 'CURSOR_EXPIRED' });
    const old = newUlid(T0 - 3 * 86_400_000);
    expect((await rt.api(ev('GET', `/api/v1/sessions/${sid}/events?after=${old}`, { token: LEARNER }))).statusCode).toBe(410);
    expect((await rt.api(ev('GET', `/api/v1/sessions/${sid}/events?after=${newUlid(T0 - 1000)}`, { token: LEARNER }))).statusCode).toBe(200);
    expect((await rt.api(ev('GET', `/api/v1/sessions/${sid}/events?after=bad`, { token: LEARNER }))).statusCode).toBe(400);
  });

  it('#25 step outage window → atl-lifecycle OpenOutageWindow', async () => {
    const lab = fixtureLab();
    (lab.steps as Record<string, unknown>[])[1]!.expectedOutage = { channel: 'lab', maxMinutes: 10, reason: '撤销实例会话' };
    await rt.objects.put(rt.deps.env.buckets.web, `content/${CATALOG_VERSION}/labs/${LAB_ID}.json`, JSON.stringify(lab));
    const calls: Record<string, unknown>[] = [];
    rt.invoker.register('atl-lifecycle', async (p) => {
      calls.push(p as Record<string, unknown>);
      if ((p as { action?: string }).action === 'OpenOutageWindow') return { outageWindow: { until: iso(T0 + 600_000), channel: 'lab', stepId: 'wire' } };
      const { DEV_LIFECYCLE_ACTIONS } = await import('../src/dev-server.js');
      return DEV_LIFECYCLE_ACTIONS[String((p as { action?: string }).action)]!(p as Record<string, unknown>, rt.deps);
    });
    const { sid } = await ready(rt);
    const r = await rt.api(ev('POST', `/api/v1/sessions/${sid}/steps/wire/outage`, { token: LEARNER, body: {} }));
    expect(r.statusCode, r.body).toBe(202);
    expect(body(r)).toMatchObject({ stepId: 'wire', outageWindow: { channel: 'lab' } });
    expect(calls.find((c) => c.action === 'OpenOutageWindow')).toMatchObject({ sessionId: sid, channel: 'lab', maxMinutes: 10, reason: '撤销实例会话', stepId: 'wire' });
    expect(body(await rt.api(ev('POST', `/api/v1/sessions/${sid}/steps/dlq/outage`, { token: LEARNER, body: {} })))).toMatchObject({ status: 400, reason: 'NO_EXPECTED_OUTAGE' });
    expect((await rt.api(ev('POST', `/api/v1/sessions/${sid}/steps/nope/outage`, { token: LEARNER, body: {} }))).statusCode).toBe(404);
    expect((await rt.api(ev('POST', `/api/v1/sessions/${sid}/steps/wire/outage`, { token: OBSERVER, body: {} }))).statusCode).toBe(403);
  });

  it('#28 environment ledger by envId (L A), state filter; /resources/manual items name the card and times', async () => {
    const { sid, envId } = await ready(rt);
    const mk = (k: string, state: string) =>
      rt.repos.table.put({
        ...Keys.sessionResource(envId, k),
        ...(Gsi2.sessionResource(state as never, envId, k) ?? {}),
        type: 'SessionResource',
        ver: 1,
        createdAt: iso(T0),
        updatedAt: iso(T0),
        resourceKey: k,
        envId,
        sessionId: sid,
        cleanupState: state,
        severity: 'BLOCKING',
        billing: 'hourly',
        resourceType: 'AWS::RDS::DBInstance',
        createdBy: 'learner',
      });
    await mk('a'.repeat(32), 'MANUAL_REQUIRED');
    await mk('b'.repeat(32), 'DELETED');
    const all = body(await rt.api(ev('GET', `/api/v1/environments/${envId}/resources`, { token: ASSISTANT })));
    expect(all).toMatchObject({ envId, total: 2, sessionChain: [sid], countedBy: 'environment' });
    expect(body(await rt.api(ev('GET', `/api/v1/environments/${envId}/resources?state=MANUAL_REQUIRED`, { token: LEARNER })))).toMatchObject({ total: 1, items: [{ resourceKey: 'a'.repeat(32), cleanupState: 'MANUAL_REQUIRED' }] });
    expect((await rt.api(ev('GET', `/api/v1/environments/${envId}/resources`, { token: OBSERVER }))).statusCode).toBe(403);
    expect((await rt.api(ev('GET', '/api/v1/environments/nope/resources', { token: LEARNER }))).statusCode).toBe(404);
    const manual = body(await rt.api(ev('GET', '/api/v1/resources/manual', { token: LEARNER })));
    expect(manual.items).toEqual([expect.objectContaining({ resourceKey: 'a'.repeat(32), labId: LAB_ID, sessionCreatedAt: expect.any(String), sessionState: 'READY' })]);
  });
});
