/**
 * End-to-end scenarios of the API functions (atl-api, atl-agent, atl-public) over a document client. Run against the
 * in-memory client (`api-flows.test.ts`) and against DynamoDB Local (`api-flows.it.test.ts`, CLOUDALBUM_IT=1 or
 * ATL_IT=1).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { canonicalJson, ExecutionNames, Keys, parseAgentContext, type JwtPrincipal } from '@atl/shared';
import { devAdvance } from '../../src/dev-server.js';
import type { ApiExtensions } from '../../src/routes/index.js';
import { ASSISTANT, body, ev, LEARNER, OBSERVER, provCaller, wsCaller, type ApiTestRuntime } from './api-runtime.js';
import { experimentResult, LAB_ID } from './fixtures.js';

type Make = (ext?: ApiExtensions) => Promise<ApiTestRuntime>;

const withDigest = (r: Record<string, unknown>) => ({
  ...r,
  integrity: { canonicalization: 'RFC8785', digest: `sha256:${createHash('sha256').update(canonicalJson(r)).digest('hex')}` },
});

async function quoteAndStart(rt: ApiTestRuntime, opts: { variant?: string } = {}) {
  const q = await rt.api(ev('POST', `/api/v1/labs/${LAB_ID}/quotes`, { token: LEARNER, body: { purpose: 'START', ...(opts.variant ? { variant: opts.variant } : {}) } }));
  expect(q.statusCode, q.body).toBe(201);
  const quoteId = body(q).quoteId as string;
  const r = await rt.api(ev('POST', '/api/v1/sessions', { token: LEARNER, body: { labId: LAB_ID, quoteId, costAcknowledged: true, ...(opts.variant ? { variant: opts.variant } : {}) } }));
  expect(r.statusCode, r.body).toBe(202);
  return { quoteId, sid: body(r).sessionId as string, res: r };
}

async function startReady(rt: ApiTestRuntime) {
  const { sid } = await quoteAndStart(rt);
  await devAdvance(rt.deps, sid, 'PROVISIONING');
  await devAdvance(rt.deps, sid, 'READY');
  return sid;
}

export function defineApiScenarios(label: string, make: Make): void {
  describe(`API flows (${label})`, () => {
    let rt: ApiTestRuntime;
    beforeEach(async () => {
      rt = await make();
    });

    it('me, time, platform, guardrails, settings', async () => {
      expect(body(await rt.api(ev('GET', '/api/v1/time', { token: OBSERVER }))).serverNow).toBe('2026-10-14T01:00:00.000Z');
      const me = await rt.api(ev('GET', '/api/v1/me', { token: LEARNER }));
      expect(body(me)).toMatchObject({ sub: 'u-learner', groups: ['learner'], currentTrackId: 'saa-main' });
      const patched = await rt.api(ev('PATCH', '/api/v1/me', { token: LEARNER, body: { displayName: '张三', currentTrackId: 'saa-main' } }));
      expect(body(patched).displayName).toBe('张三');
      expect((await rt.api(ev('PATCH', '/api/v1/me', { token: LEARNER, body: { currentTrackId: 'nope-track' } }))).statusCode).toBe(400);
      const platform = body(await rt.api(ev('GET', '/api/v1/platform', { token: ASSISTANT })));
      expect(platform).toMatchObject({ catalogVersion: '2026.10.0', mode: 'NORMAL', maintenance: false, accountId: '111122223333' });
      expect(body(await rt.api(ev('GET', '/api/v1/platform/guardrails', { token: OBSERVER })))).toMatchObject({ uninstalling: false, budget: { state: 'OK' } });
      const settings = body(await rt.api(ev('GET', '/api/v1/settings', { token: LEARNER })));
      expect(settings.limits).toMatchObject({ maxKeepHours: 24 });
      const tooMuch = await rt.api(ev('PATCH', '/api/v1/settings', { token: LEARNER, body: { limits: { maxKeepHours: 48 } } }));
      expect(body(tooMuch).code).toBe('VALIDATION_FAILED');
      const ok = await rt.api(ev('PATCH', '/api/v1/settings', { token: LEARNER, body: { limits: { readyIdleMinutes: 30 }, reclaim: { blockStartOnResidual: 'block' } } }));
      expect(body(ok)).toMatchObject({ limits: { readyIdleMinutes: 30, maxKeepHours: 24 }, reclaim: { blockStartOnResidual: 'block' } });
      const stale = await rt.api(ev('PATCH', '/api/v1/settings', { token: LEARNER, headers: { 'if-match': '"1"' }, body: { limits: { readyIdleMinutes: 20 } } }));
      expect(stale.statusCode).toBe(412);
      expect((await rt.api(ev('GET', '/api/v1/settings', { token: ASSISTANT }))).statusCode).toBe(403);
    });

    it('catalog, labs, startability, tracks and conditional GET', async () => {
      const cat = await rt.api(ev('GET', '/api/v1/catalog', { token: OBSERVER }));
      expect(body(cat)).toMatchObject({ catalogVersion: '2026.10.0', indexUrl: '/content/2026.10.0/catalog/index.json' });
      expect(cat.headers?.etag).toBe('"2026.10.0"');
      expect((await rt.api(ev('GET', '/api/v1/catalog', { token: OBSERVER, headers: { 'if-none-match': '"2026.10.0"' } }))).statusCode).toBe(304);
      const lab = body(await rt.api(ev('GET', `/api/v1/labs/${LAB_ID}`, { token: LEARNER })));
      expect(lab).toMatchObject({ labId: LAB_ID, progress: { status: 'not_started', attempts: 0 }, startability: { canStart: true, reasons: [] } });
      expect((lab.startability as { variants: { id: string }[] }).variants.map((v) => v.id)).toEqual(['default', 'fifo']);
      expect((await rt.api(ev('GET', '/api/v1/labs/svc-nope', { token: LEARNER }))).statusCode).toBe(404);
      const labs = await rt.api(ev('GET', '/api/v1/labs', { token: LEARNER }));
      expect(body(labs)).toMatchObject({ catalogVersion: '2026.10.0', environment: null, items: [] });
      expect((await rt.api(ev('GET', '/api/v1/labs', { token: LEARNER, headers: { 'if-none-match': labs.headers!.etag! } }))).statusCode).toBe(304);
      const tracks = body(await rt.api(ev('GET', '/api/v1/tracks', { token: LEARNER })));
      expect(tracks.items).toEqual([expect.objectContaining({ id: 'saa-main', progress: { requiredDone: 0, requiredTotal: 1, completed: false, eligible: false } })]);
      const track = body(await rt.api(ev('GET', '/api/v1/tracks/saa-main', { token: LEARNER })));
      expect(track.certificate).toMatchObject({ eligible: false, current: null });
      expect(((track.certificate as { reasons: { code: string }[] }).reasons).map((r) => r.code)).toEqual(['REQUIRED_CARD_MISSING', 'GROUP_PICK_UNMET']);
      const mastery = body(await rt.api(ev('GET', '/api/v1/me/mastery', { token: OBSERVER })));
      expect(mastery.services).toEqual([expect.objectContaining({ id: 'sqs', level: 'not_started', score: 0 })]);
      const defective = await rt.api(ev('POST', '/api/v1/catalog/releases/2026.10.0/defective', { token: LEARNER, body: { reason: '检查语义错误' } }));
      expect(body(defective).defective).toMatchObject({ by: 'u-learner', reason: '检查语义错误' });
    });

    it('quotes: no invented prices, variant checks, 15-minute validity', async () => {
      const q = body(await rt.api(ev('POST', `/api/v1/labs/${LAB_ID}/quotes`, { token: LEARNER, body: { purpose: 'START' } })));
      expect(q).toMatchObject({ purpose: 'START', labId: LAB_ID, variant: 'default', labVersion: '1.0.0', pricing: 'unavailable', hourly: null, startProfile: 'atl/svc-queue/default', startProfileDigest: 'sha256:aaaa', durationMinutes: 90, maxTotalMinutes: 150 });
      expect(q.expiresAt).toBe('2026-10-14T01:15:00.000Z');
      expect(q.incomplete).toEqual(expect.arrayContaining(['ref:start-profile', 'sqs.requests']));
      expect((q.lines as { unknown?: boolean }[]).every((l) => l.unknown)).toBe(true);
      expect(body(await rt.api(ev('POST', `/api/v1/labs/${LAB_ID}/quotes`, { token: LEARNER, body: { purpose: 'START', variant: 'nope' } }))).code).toBe('VARIANT_UNKNOWN');
      expect((await rt.api(ev('POST', `/api/v1/labs/${LAB_ID}/quotes`, { token: OBSERVER, body: { purpose: 'START' } }))).statusCode).toBe(403);
    });

    it('start: validation, quote checks, single active session, idempotency', async () => {
      const q = body(await rt.api(ev('POST', `/api/v1/labs/${LAB_ID}/quotes`, { token: LEARNER, body: { purpose: 'START' } })));
      const start = (b: Record<string, unknown>, key?: string) => rt.api(ev('POST', '/api/v1/sessions', { token: LEARNER, body: b, ...(key ? { key } : {}) }));
      const noKey = await rt.api({ ...ev('POST', '/api/v1/sessions', { token: LEARNER, body: { labId: LAB_ID } }), headers: { authorization: `Bearer ${LEARNER}` } });
      expect(body(noKey).code).toBe('VALIDATION_FAILED');
      expect(body(await start({ labId: LAB_ID, quoteId: q.quoteId, costAcknowledged: false })).code).toBe('COST_ACK_REQUIRED');
      expect(body(await start({ labId: LAB_ID, quoteId: q.quoteId, costAcknowledged: true, variant: 'fifo' })).code).toBe('QUOTE_MISMATCH');
      expect(body(await start({ labId: LAB_ID, quoteId: '01JA3M0Q2V6K8B1N4C7D9E2F3G', costAcknowledged: true })).code).toBe('QUOTE_EXPIRED');
      expect(body(await start({ labId: LAB_ID, quoteId: q.quoteId, costAcknowledged: true, workstation: 'nope' })).code).toBe('VALIDATION_FAILED');

      const r = await start({ labId: LAB_ID, quoteId: q.quoteId, costAcknowledged: true }, 'start-key-0001');
      expect(r.statusCode, r.body).toBe(202);
      const view = body(r);
      const sid = view.sessionId as string;
      expect(r.headers?.location).toBe(`/api/v1/sessions/${sid}`);
      expect(view).toMatchObject({ state: 'REQUESTED', ver: 1, labId: LAB_ID, variant: 'default', allowedActions: ['cancel'], serverNow: '2026-10-14T01:00:00.000Z' });
      const s = await rt.repos.sessions.get(sid);
      expect(s).toMatchObject({ startProfile: 'atl/svc-queue/default', startProfileDigest: 'sha256:aaaa', cardFacts: { platformActions: ['queue-purge'], sshFromWorkstation: false, testUsersSeeded: false }, targetModules: [{ id: 'queue', from: 'memory', to: 'sqs' }] });
      expect(String(s!.startExecutionArn)).toContain(`:execution:atl-session-start:${ExecutionNames.start(sid)}`);
      expect(rt.orchestrator.started('atl-session-start').map((e) => e.input)).toEqual([{ sessionId: sid }]);

      // replay with the same key → same response; same key + other body → 422
      const replay = await start({ labId: LAB_ID, quoteId: q.quoteId, costAcknowledged: true }, 'start-key-0001');
      expect(replay.headers?.['idempotent-replayed']).toBe('true');
      expect(body(replay).sessionId).toBe(sid);
      const reused = await start({ labId: LAB_ID, quoteId: q.quoteId, costAcknowledged: true, residualAck: true }, 'start-key-0001');
      expect(reused.statusCode).toBe(422);
      // a second start while the first is REQUESTED → 409 (single active session)
      const second = await start({ labId: LAB_ID, quoteId: q.quoteId, costAcknowledged: true });
      expect(second.statusCode).toBe(409);
      expect(body(second)).toMatchObject({ code: 'SESSION_ACTIVE_EXISTS', sessionId: sid });
      // once it holds the lock: still 409, with the holder's details
      await devAdvance(rt.deps, sid, 'PROVISIONING');
      expect(body(await start({ labId: LAB_ID, quoteId: q.quoteId, costAcknowledged: true }))).toMatchObject({ code: 'SESSION_ACTIVE_EXISTS', state: 'PROVISIONING' });
      const lab = body(await rt.api(ev('GET', `/api/v1/labs/${LAB_ID}`, { token: LEARNER })));
      expect(lab.startability).toMatchObject({ canStart: false, reasons: [expect.objectContaining({ code: 'SESSION_ACTIVE_EXISTS' })] });
      // the quote expires after 15 minutes
      rt.clock.advance(16 * 60_000);
      await devAdvance(rt.deps, sid, 'CLEANING');
      expect(body(await start({ labId: LAB_ID, quoteId: q.quoteId, costAcknowledged: true })).code).toBe('QUOTE_EXPIRED');
    });

    it('session views, lists, current, ETag, events polling', async () => {
      const { sid } = await quoteAndStart(rt);
      const cur = await rt.api(ev('GET', '/api/v1/sessions/current', { token: ASSISTANT }));
      expect(cur.statusCode).toBe(204); // no learner profile yet → assistants see nothing
      await rt.api(ev('GET', '/api/v1/me', { token: LEARNER }));
      expect(body(await rt.api(ev('GET', '/api/v1/sessions/current', { token: ASSISTANT }))).sessionId).toBe(sid);
      expect(body(await rt.api(ev('GET', '/api/v1/sessions/current', { token: LEARNER }))).sessionId).toBe(sid);
      const v = await rt.api(ev('GET', `/api/v1/sessions/${sid}`, { token: OBSERVER }));
      expect(v.statusCode).toBe(200);
      rt.clock.advance(1000);
      expect((await rt.api(ev('GET', `/api/v1/sessions/${sid}`, { token: OBSERVER, headers: { 'if-none-match': v.headers!.etag! } }))).statusCode).toBe(304);
      expect((await rt.api(ev('GET', '/api/v1/sessions/s000000000000', { token: LEARNER }))).statusCode).toBe(404);
      expect((await rt.api(ev('GET', `/api/v1/sessions/${sid}`, { token: 'dev.learner.someone-else' }))).statusCode).toBe(404);

      const list = body(await rt.api(ev('GET', '/api/v1/sessions?limit=1', { token: LEARNER })));
      expect(list.items).toEqual([expect.objectContaining({ sessionId: sid, state: 'REQUESTED', labId: LAB_ID })]);
      expect(body(await rt.api(ev('GET', '/api/v1/sessions?state=ENDED', { token: LEARNER }))).items).toEqual([]);
      expect(body(await rt.api(ev('GET', '/api/v1/sessions?cursor=forged.cursor', { token: LEARNER }))).code).toBe('VALIDATION_FAILED');

      // events written in the last 2 s are held back (settle window)
      const early = body(await rt.api(ev('GET', `/api/v1/sessions/${sid}/events`, { token: LEARNER })));
      expect(early.events).toEqual([]);
      rt.clock.advance(3000);
      const page = body(await rt.api(ev('GET', `/api/v1/sessions/${sid}/events`, { token: LEARNER })));
      const types = (page.events as { type: string }[]).map((e) => e.type);
      expect(types).toEqual(['session.requested', 'session.state_changed']);
      expect(page).toMatchObject({ hasMore: false, pollAfterMs: 5000 });
      const again = body(await rt.api(ev('GET', `/api/v1/sessions/${sid}/events?after=${String(page.next)}`, { token: LEARNER })));
      expect(again).toMatchObject({ events: [], next: page.next });
      expect(body(await rt.api(ev('GET', `/api/v1/sessions/${sid}/events?after=nope`, { token: LEARNER }))).code).toBe('VALIDATION_FAILED');
      await devAdvance(rt.deps, sid, 'PROVISIONING');
      rt.clock.advance(3000);
      const next = body(await rt.api(ev('GET', `/api/v1/sessions/${sid}/events?after=${String(page.next)}`, { token: LEARNER })));
      expect((next.events as { type: string; data: Record<string, unknown> }[]).map((e) => [e.type, e.data.to])).toEqual([['session.state_changed', 'PROVISIONING']]);
    });

    it('heartbeat (T07), extend (02 §5.4) and extension limits', async () => {
      const sid = await startReady(rt);
      const hb = body(await rt.api(ev('POST', `/api/v1/sessions/${sid}/heartbeat`, { token: LEARNER, body: { workbench: true } })));
      expect(hb).toMatchObject({ state: 'RUNNING', deadlineVersion: 1, deadlineAt: '2026-10-14T02:30:00.000Z' });
      const view = body(await rt.api(ev('GET', `/api/v1/sessions/${sid}`, { token: LEARNER })));
      expect(view).toMatchObject({ state: 'RUNNING', limits: { extensionsLeft: 2, extensionMinutes: 30, maxDeadlineAt: '2026-10-14T03:30:00.000Z' } });
      expect(view.allowedActions).toEqual(['extend', 'end', 'end-keep']);
      const extendOnce = async (version: number) => {
        const q = body(await rt.api(ev('POST', `/api/v1/sessions/${sid}/quotes`, { token: LEARNER, body: { purpose: 'EXTEND', minutes: 30 } })));
        return rt.api(ev('POST', `/api/v1/sessions/${sid}/extend`, { token: LEARNER, body: { minutes: 30, quoteId: q.quoteId, expectedDeadlineVersion: version } }));
      };
      const first = await extendOnce(1);
      expect(first.statusCode, first.body).toBe(200);
      expect(body(first)).toMatchObject({ deadlineVersion: 2, deadlineAt: '2026-10-14T03:00:00.000Z', limits: { extensionsLeft: 1 } });
      expect(body(await extendOnce(1)).code).toBe('PRECONDITION_FAILED');
      expect((await extendOnce(2)).statusCode).toBe(200);
      const third = await rt.api(ev('POST', `/api/v1/sessions/${sid}/quotes`, { token: LEARNER, body: { purpose: 'EXTEND', minutes: 30 } }));
      expect(body(third).code).toBe('EXTENSION_LIMIT');
      // keep quote respects the card's retain.maxHours (12)
      expect(body(await rt.api(ev('POST', `/api/v1/sessions/${sid}/quotes`, { token: LEARNER, body: { purpose: 'KEEP', keepHours: 24 } }))).code).toBe('LIMIT_EXCEEDED');
      // near the deadline the heartbeat moves the session to EXPIRING (T08)
      rt.clock.advance((150 - 10) * 60_000);
      expect(body(await rt.api(ev('POST', `/api/v1/sessions/${sid}/heartbeat`, { token: LEARNER, body: {} }))).state).toBe('EXPIRING');
      rt.clock.advance(10 * 60_000);
      const late = await rt.api(ev('POST', `/api/v1/sessions/${sid}/extend`, { token: LEARNER, body: { minutes: 30, quoteId: 'x'.repeat(26), expectedDeadlineVersion: 3 } }));
      expect(body(late).code).toBe('SESSION_EXPIRING_OR_ENDED');
    });

    it('end: at-expiry preference, keep checks, end now starts end-<sid>-1, cancel before PROVISIONING (T04)', async () => {
      const sid = await startReady(rt);
      expect(body(await rt.api(ev('POST', `/api/v1/sessions/${sid}/end`, { token: LEARNER, body: { disposition: 'keep', when: 'now' } }))).code).toBe('VALIDATION_FAILED');
      const kq = body(await rt.api(ev('POST', `/api/v1/sessions/${sid}/quotes`, { token: LEARNER, body: { purpose: 'KEEP', keepHours: 4 } })));
      const pref = await rt.api(ev('POST', `/api/v1/sessions/${sid}/end`, { token: LEARNER, body: { disposition: 'keep', keepHours: 4, quoteId: kq.quoteId, when: 'at-expiry' } }));
      expect(pref.statusCode, pref.body).toBe(202);
      expect(body(pref).preferredDisposition).toMatchObject({ disposition: 'keep', keepHours: 4, quoteId: kq.quoteId });
      expect(rt.orchestrator.started('atl-session-end')).toEqual([]);
      const stale = await rt.api(ev('POST', `/api/v1/sessions/${sid}/end`, { token: LEARNER, headers: { 'if-match': '"1"' }, body: { disposition: 'destroy', when: 'now' } }));
      expect(stale.statusCode).toBe(412);
      const end = await rt.api(ev('POST', `/api/v1/sessions/${sid}/end`, { token: LEARNER, body: { disposition: 'destroy', when: 'now' } }));
      expect(end.statusCode).toBe(202);
      const ends = rt.orchestrator.started('atl-session-end');
      expect(ends.map((e) => e.name)).toEqual([ExecutionNames.endFirst(sid)]);
      expect(ends[0]!.input).toMatchObject({ sessionId: sid, reason: 'USER_ENDED', disposition: 'destroy', actor: 'user' });
      // pressing “end” again while the end workflow runs: same execution, still 202
      expect((await rt.api(ev('POST', `/api/v1/sessions/${sid}/end`, { token: LEARNER, body: { disposition: 'destroy', when: 'now' } }))).statusCode).toBe(202);
      expect(rt.orchestrator.started('atl-session-end')).toHaveLength(1);

      // a second learner flow: cancel while REQUESTED
      await devAdvance(rt.deps, sid, 'ENDING');
      await devAdvance(rt.deps, sid, 'CLEANING');
      await devAdvance(rt.deps, sid, 'ENDED');
      const { sid: sid2 } = await quoteAndStart(rt);
      const cancel = await rt.api(ev('POST', `/api/v1/sessions/${sid2}/end`, { token: LEARNER, body: { disposition: 'destroy' } }));
      expect(body(cancel)).toMatchObject({ state: 'ENDED', stateReason: 'CANCELLED' });
      expect(body(await rt.api(ev('POST', `/api/v1/sessions/${sid2}/end`, { token: LEARNER, body: { disposition: 'destroy' } }))).code).toBe('INVALID_STATE');
    });

    it('keep: extend (T13) and release (end-<sid>-rel), reuse reservation blocks release', async () => {
      const sid = await startReady(rt);
      await devAdvance(rt.deps, sid, 'ENDING');
      await devAdvance(rt.deps, sid, 'KEPT', 120);
      const kq = body(await rt.api(ev('POST', `/api/v1/sessions/${sid}/quotes`, { token: LEARNER, body: { purpose: 'KEEP', keepHours: 2 } })));
      const ext = await rt.api(ev('POST', `/api/v1/sessions/${sid}/keep/extend`, { token: LEARNER, body: { hours: 2, quoteId: kq.quoteId } }));
      expect(ext.statusCode, ext.body).toBe(200);
      expect(body(ext)).toMatchObject({ state: 'KEPT', keep: { version: 2, until: '2026-10-14T05:00:00.000Z' }, allowedActions: ['keep-extend', 'keep-release', 'reuse'] });
      const lab = body(await rt.api(ev('GET', `/api/v1/labs/${LAB_ID}`, { token: LEARNER })));
      expect(lab.startability).toMatchObject({ reuse: { fromLabId: LAB_ID, compatible: true } });
      const lock = await rt.repos.platform.lock();
      await rt.repos.platform.reserve('s1111111111111'.slice(0, 13), sid, String(lock!.holderEnvId), new Date(rt.clock.nowMs() + 5 * 60_000).toISOString(), new Date(rt.clock.nowMs()).toISOString());
      expect(body(await rt.api(ev('POST', `/api/v1/sessions/${sid}/keep/release`, { token: LEARNER }))).code).toBe('REUSE_IN_PROGRESS');
      await rt.repos.platform.clearReservation('s1111111111111'.slice(0, 13), new Date(rt.clock.nowMs()).toISOString());
      const rel = await rt.api(ev('POST', `/api/v1/sessions/${sid}/keep/release`, { token: LEARNER }));
      expect(rel.statusCode).toBe(202);
      expect(rt.orchestrator.started('atl-session-end').map((e) => [e.name, (e.input as { reason: string }).reason])).toEqual([[ExecutionNames.endRelease(sid), 'KEEP_RELEASED']]);
      const env = body(await rt.api(ev('GET', '/api/v1/environments/current', { token: OBSERVER })));
      expect(env).toMatchObject({ envId: lock!.holderEnvId, session: { sessionId: sid, state: 'KEPT' } });
    });

    it('cleanup report, manual list, resolve, retry (T19)', async () => {
      const sid = await startReady(rt);
      const s = await rt.repos.sessions.get(sid);
      const envId = String(s!.envId);
      const rk = 'ab'.repeat(16);
      const nowIso = new Date(rt.clock.nowMs()).toISOString();
      const { Gsi1, Gsi2 } = await import('@atl/shared');
      await rt.repos.table.put({
        ...Keys.sessionResource(envId, rk),
        ...Gsi1.sessionResource(sid, nowIso, rk),
        ...Gsi2.sessionResource('MANUAL_REQUIRED', envId, rk)!,
        type: 'SessionResource',
        ver: 1,
        createdAt: nowIso,
        updatedAt: nowIso,
        resourceKey: rk,
        resourceType: 'AWS::RDS::DBInstance',
        region: 'ap-northeast-1',
        name: 'cloudalbum-db',
        sessionId: sid,
        createdBy: 'learner',
        billing: 'hourly',
        cleanupState: 'MANUAL_REQUIRED',
        severity: 'BLOCKING',
        lastError: 'deletion protection',
        manualHint: { consoleUrl: 'https://console.aws.amazon.com/rds', cli: 'aws rds delete-db-instance …' },
      });
      await devAdvance(rt.deps, sid, 'ENDING');
      await devAdvance(rt.deps, sid, 'CLEANING');
      await devAdvance(rt.deps, sid, 'CLEANUP_FAILED');
      const report = body(await rt.api(ev('GET', `/api/v1/sessions/${sid}/cleanup`, { token: ASSISTANT })));
      expect(report).toMatchObject({ status: 'CLEANUP_FAILED', hourlyBlocking: 1, items: [expect.objectContaining({ resourceKey: rk, severity: 'BLOCKING', type: 'AWS::RDS::DBInstance' })] });
      const md = await rt.api(ev('GET', `/api/v1/sessions/${sid}/cleanup?format=md`, { token: LEARNER }));
      expect(md.headers?.['content-type']).toMatch(/text\/markdown/);
      expect(md.body).toContain('aws rds delete-db-instance');
      expect(body(await rt.api(ev('GET', '/api/v1/resources/manual', { token: LEARNER })))).toMatchObject({ total: 1, hourlyBlocking: 1 });
      expect(body(await rt.api(ev('GET', `/api/v1/sessions/${sid}/resources?state=MANUAL_REQUIRED`, { token: LEARNER }))).items).toHaveLength(1);
      const cost = body(await rt.api(ev('GET', `/api/v1/sessions/${sid}/cost`, { token: LEARNER })));
      expect(cost).toMatchObject({ hourly: null, estimate: null, unestimatedManualResources: 1 });
      // a residue blocks a new start until acknowledged (policy ack)
      const q = body(await rt.api(ev('POST', `/api/v1/labs/${LAB_ID}/quotes`, { token: LEARNER, body: { purpose: 'START' } })));
      expect(body(await rt.api(ev('POST', '/api/v1/sessions', { token: LEARNER, body: { labId: LAB_ID, quoteId: q.quoteId, costAcknowledged: true } }))).code).toBe('RESIDUAL_ACK_REQUIRED');
      const resolve = await rt.api(ev('POST', `/api/v1/sessions/${sid}/cleanup/items/${rk}/resolve`, { token: LEARNER, body: { note: '已在控制台删除' } }));
      expect(resolve.statusCode).toBe(202);
      await rt.flush();
      expect(rt.calls.find((c) => c.fn === 'atl-lifecycle' && (c.payload as { action?: string }).action === 'ResolveCleanup')?.payload).toMatchObject({ action: 'ResolveCleanup', envId, resourceKey: rk, sessionId: sid });
      const retry = await rt.api(ev('POST', `/api/v1/sessions/${sid}/cleanup/retry`, { token: LEARNER }));
      expect(retry.statusCode).toBe(202);
      expect(rt.orchestrator.started('atl-session-end').map((e) => e.name)).toEqual([ExecutionNames.endRetry(sid, 1)]);
      expect((await rt.repos.sessions.get(sid))!.cleanupRetryCount).toBe(1);
      const started = await rt.api(ev('POST', '/api/v1/sessions', { token: LEARNER, body: { labId: LAB_ID, quoteId: q.quoteId, costAcknowledged: true, residualAck: true } }));
      expect(started.statusCode, started.body).toBe(202);
    });

    it('workspace: descriptor, events, provider-backed terminal and console routes', async () => {
      const opened: string[] = [];
      const ext: ApiExtensions = {
        workspace: {
          openTerminal: async (c, b) => {
            opened.push(`${c.session.sid}:${b.target}`);
            return { status: 201, body: { terminalId: '01JA3P0A1B2C3D4E5F6G7H8J9K', instanceId: 'i-0abc1234def567890', streamUrl: 'wss://ssmmessages.ap-northeast-1.amazonaws.com/v1/data-channel/x', tokenValue: 't' } };
          },
          resumeTerminal: async () => ({ status: 200, body: { streamUrl: 'wss://x', tokenValue: 't' } }),
          closeTerminal: async () => ({ status: 204, body: null }),
          consoleLink: async () => ({ status: 200, body: { form: { action: 'https://signin.aws.amazon.com/federation' }, consoleSessionExpiresAt: '2026-10-14T02:00:00Z' } }),
          appCredentials: async () => ({ status: 200, body: { username: 'admin', password: 'p' } }),
        },
      };
      rt = await make(ext);
      const sid = await startReady(rt);
      const ws = body(await rt.api(ev('GET', `/api/v1/sessions/${sid}/workspace`, { token: OBSERVER })));
      expect(ws).toMatchObject({ sessionId: sid, access: { available: true }, console: { available: true, links: [{ linkId: 'sqs.queues' }] }, features: { workstation: 'ec2', previewDirectHttps: 'on', provider: true } });
      const t = await rt.api(ev('POST', `/api/v1/sessions/${sid}/terminals`, { token: LEARNER, body: { target: 'lab' } }));
      expect(t.statusCode, t.body).toBe(201);
      expect(opened).toEqual([`${sid}:lab`]);
      expect((await rt.api(ev('POST', `/api/v1/sessions/${sid}/terminals`, { token: ASSISTANT, body: { target: 'lab' } }))).statusCode).toBe(403);
      const stale = await rt.api(ev('POST', `/api/v1/sessions/${sid}/console-link`, { token: `dev.learner.u-learner.${Math.floor(rt.clock.nowMs() / 1000) - 7200}`, body: {} }));
      expect(body(stale).code).toBe('REAUTH_REQUIRED');
      expect((await rt.api(ev('POST', `/api/v1/sessions/${sid}/console-link`, { token: LEARNER, body: { linkId: 'sqs.queues' } }))).statusCode).toBe(200);
      expect((await rt.api(ev('GET', `/api/v1/sessions/${sid}/app-credentials`, { token: LEARNER }))).statusCode).toBe(200);
      expect((await rt.api(ev('DELETE', `/api/v1/sessions/${sid}/terminals/01JA3P0A1B2C3D4E5F6G7H8J9K`, { token: LEARNER }))).statusCode).toBe(204);
      const wev = await rt.api(ev('POST', `/api/v1/sessions/${sid}/workspace-events`, { token: LEARNER, body: { events: [{ type: 'workspace.command_pasted', data: { stepId: 'wire', blockIndex: 1, tab: 'terminal-lab', mode: 'paste', textSha256: 'abc', text: 'rm -rf /' } }] } }));
      expect(wev.statusCode).toBe(202);
      expect(body(await rt.api(ev('POST', `/api/v1/sessions/${sid}/workspace-events`, { token: LEARNER, body: { events: [{ type: 'workspace.keylogger' }] } }))).code).toBe('VALIDATION_FAILED');
      rt.clock.advance(3000);
      const evs = (body(await rt.api(ev('GET', `/api/v1/sessions/${sid}/events`, { token: LEARNER }))).events as { type: string; data: Record<string, unknown> }[]).filter((e) => !e.type.startsWith('session.'));
      expect(evs.map((e) => e.type)).toEqual(['terminal.opened', 'console_link.issued', 'terminal.closed', 'workspace.command_pasted']);
      expect(evs[3]!.data).not.toHaveProperty('text');
      const audits = (await rt.repos.audit.bySession(sid)).map((a) => [a.action, a.result]);
      expect(audits).toEqual(expect.arrayContaining([['terminal.start', 'ok'], ['access.denied', 'denied'], ['console_link.issue', 'ok'], ['app_credentials.reveal', 'ok'], ['terminal.stop', 'ok']]));
      const preview = body(await rt.api(ev('GET', `/api/v1/sessions/${sid}/preview`, { token: OBSERVER })));
      expect(preview).toMatchObject({ available: true, targets: [{ id: 'app', url: 'http://127.0.0.1:8080', embeddable: false, reason: 'MIXED_CONTENT' }] });
      // after the deadline no more access
      rt.clock.advance(3 * 3600_000);
      expect(body(await rt.api(ev('POST', `/api/v1/sessions/${sid}/terminals`, { token: LEARNER, body: { target: 'lab' } }))).code).toBe('TERMINAL_SESSION_STATE');
    });

    it('workspace routes without a provider answer 501', async () => {
      const sid = await startReady(rt);
      const r = await rt.api(ev('POST', `/api/v1/sessions/${sid}/terminals`, { token: LEARNER, body: { target: 'lab' } }));
      expect(r.statusCode).toBe(501);
      expect(body(r).code).toBe('NOT_IMPLEMENTED');
    });

    it('steps, checks, manual confirmations, platform actions, vars', async () => {
      const sid = await startReady(rt);
      const run = await rt.api(ev('POST', `/api/v1/sessions/${sid}/steps/wire/check-runs`, { token: ASSISTANT, body: { force: true } }));
      expect(run.statusCode).toBe(202);
      const runId = body(run).runId as string;
      await rt.flush();
      expect(rt.calls.find((c) => c.payload.action === 'RunChecks')?.payload).toMatchObject({ runId, sessionId: sid, stepId: 'wire', force: true, trigger: 'user', requestedBy: { role: 'assistant' } });
      expect(body(await rt.api(ev('GET', `/api/v1/sessions/${sid}/check-runs/${runId}`, { token: OBSERVER })))).toMatchObject({ runId, state: 'queued' });
      expect((await rt.api(ev('POST', `/api/v1/sessions/${sid}/steps/nope/check-runs`, { token: LEARNER, body: {} }))).statusCode).toBe(404);
      const mc = await rt.api(ev('POST', `/api/v1/sessions/${sid}/steps/wire/manual-confirmations`, { token: LEARNER, body: { checkId: 'queue-cap', observed: 'driver=sqs', note: '控制台看到队列在消费' } }));
      expect(mc.statusCode, mc.body).toBe(201);
      expect(body(mc)).toMatchObject({ kind: 'degraded', reviewPending: true });
      const native = body(await rt.api(ev('POST', `/api/v1/sessions/${sid}/steps/dlq/manual-confirmations`, { token: LEARNER, body: { checkId: 'dlq-ok', observed: 'ok', note: '收到确认订阅邮件', evidence: 'x' } })));
      expect(native).toMatchObject({ kind: 'native', result: 'manual_evidence', reviewPending: false });
      const review = await rt.api(ev('POST', `/api/v1/sessions/${sid}/manual-confirmations/${String(body(mc).confirmationId)}/review`, { token: ASSISTANT, body: { decision: 'approve', comment: '可以' } }));
      expect(body(review)).toMatchObject({ review: { by: 'u-ta', decision: 'approve' } });
      expect(body(await rt.api(ev('POST', `/api/v1/sessions/${sid}/manual-confirmations/${String(body(mc).confirmationId)}/review`, { token: ASSISTANT, body: { decision: 'reject' } }))).code).toBe('INVALID_STATE');
      expect((await rt.api(ev('POST', `/api/v1/sessions/${sid}/steps/wire/skip`, { token: LEARNER, body: {} }))).statusCode).toBe(400);
      expect((await rt.api(ev('POST', `/api/v1/sessions/${sid}/steps/dlq/skip`, { token: LEARNER, body: {} }))).statusCode).toBe(202);
      expect((await rt.api(ev('POST', `/api/v1/sessions/${sid}/submit`, { token: LEARNER, body: {} }))).statusCode).toBe(202);
      expect(body(await rt.api(ev('POST', `/api/v1/sessions/${sid}/module-ops`, { token: LEARNER, body: { actionId: 'cost-activate-tags' } }))).code).toBe('OP_NOT_ALLOWED');
      const op = await rt.api(ev('POST', `/api/v1/sessions/${sid}/module-ops`, { token: LEARNER, body: { actionId: 'queue-purge' } }));
      expect(op.statusCode).toBe(202);
      expect(rt.orchestrator.started('atl-module-op').map((e) => e.name)).toEqual([ExecutionNames.moduleOp(sid, 1)]);
      const op2 = await rt.api(ev('POST', `/api/v1/sessions/${sid}/module-ops`, { token: LEARNER, body: { actionId: 'queue-purge' } }));
      expect(body(op2).execution).toBe(ExecutionNames.moduleOp(sid, 2));
      // input variables are validated and stored on the attempt (once READY)
      await rt.repos.table.put({ ...Keys.labAttempt(sid), type: 'LabAttempt', ver: 1, status: 'active', variables: {} });
      expect(body(await rt.api(ev('PUT', `/api/v1/sessions/${sid}/vars/queueName`, { token: LEARNER, body: { value: 'BAD NAME' } }))).code).toBe('VALIDATION_FAILED');
      expect((await rt.api(ev('PUT', `/api/v1/sessions/${sid}/vars/queueName`, { token: LEARNER, body: { value: 'photo-jobs' } }))).statusCode).toBe(200);
      const vars = body(await rt.api(ev('GET', `/api/v1/sessions/${sid}/vars`, { token: OBSERVER })));
      expect(vars).toMatchObject({ session: { accountId: '********3333' }, vars: [{ name: 'queueName', value: 'photo-jobs' }] });
      const progress = body(await rt.api(ev('GET', `/api/v1/sessions/${sid}/progress`, { token: OBSERVER })));
      expect(progress).toMatchObject({ status: 'active', stepsTotal: 2, stepsDone: 0, missing: ['observe-sync', 'wire'] });
    });

    it('agent routes: context (PROVISIONING allowed), experiment register → upload → poll, module-op reports', async () => {
      const { sid } = await quoteAndStart(rt);
      expect(body(await rt.agent(ev('GET', `/api/v1/agent/sessions/${sid}/context`, { caller: wsCaller(sid) }))).code).toBe('SESSION_NOT_RUNNING');
      await devAdvance(rt.deps, sid, 'PROVISIONING');
      const ctx = await rt.agent(ev('GET', `/api/v1/agent/sessions/${sid}/context`, { caller: wsCaller(sid) }));
      expect(ctx.statusCode, ctx.body).toBe(200);
      const parsed = parseAgentContext(body(ctx));
      expect(parsed).toMatchObject({ sessionId: sid, sessionState: 'PROVISIONING', labId: LAB_ID, region: 'ap-northeast-1', platformActions: ['queue-purge'], cloudalbum: { testUsersParam: null, opsReport: 'agent' } });
      expect(body(await rt.agent(ev('POST', `/api/v1/agent/sessions/${sid}/experiment-runs`, { caller: wsCaller(sid), body: { module: 'queue', experiment: 'burst', label: 'before' } }))).code).toBe('SESSION_NOT_RUNNING');
      await devAdvance(rt.deps, sid, 'READY');
      expect(body(await rt.agent(ev('POST', `/api/v1/agent/sessions/${sid}/experiment-runs`, { caller: wsCaller(sid), body: { module: 'queue', experiment: 'nope', label: 'before' } }))).code).toBe('EXPERIMENT_NOT_IN_LAB');
      expect(body(await rt.agent(ev('POST', `/api/v1/agent/sessions/${sid}/experiment-runs`, { caller: wsCaller(sid), body: { module: 'queue', experiment: 'burst', label: 'during' } }))).code).toBe('LABEL_NOT_IN_LAB');
      const reg = await rt.agent(ev('POST', `/api/v1/agent/sessions/${sid}/experiment-runs`, { caller: wsCaller(sid), body: { module: 'queue', experiment: 'burst', label: 'before' } }));
      expect(reg.statusCode, reg.body).toBe(201);
      const runId = body(reg).runId as string;
      expect(body(reg)).toMatchObject({ variant: { label: 'before', role: 'baseline', cardVariant: 'default' }, headers: { 'X-Experiment-Run': runId } });
      const put = (b: unknown, key?: string) => rt.agent(ev('PUT', `/api/v1/agent/sessions/${sid}/experiment-runs/${runId}/result`, { caller: wsCaller(sid), body: b, ...(key ? { key } : {}) }));
      expect(body(await put({ schema: 'nope' })).code).toBe('SCHEMA_INVALID');
      const good = withDigest(experimentResult(sid, runId));
      expect(body(await put({ ...good, notes: 'edited after hashing' })).code).toBe('DIGEST_MISMATCH');
      expect(body(await put(withDigest(experimentResult(sid, runId, 'after')))).code).toBe('RUN_MISMATCH');
      const up = await put(good, 'upload-key-0001');
      expect(up.statusCode, up.body).toBe(202);
      expect(body(up)).toEqual({ runId, status: 'corroborating' });
      expect(body(await put(good, 'upload-key-0002')).code).toBe('ALREADY_SUBMITTED');
      expect((await put(good, 'upload-key-0001')).headers?.['idempotent-replayed']).toBe('true');
      await rt.flush();
      expect(rt.calls.find((c) => c.payload.action === 'CrossCheckExperiment')?.payload).toEqual({ action: 'CrossCheckExperiment', sessionId: sid, runId });
      const polled = body(await rt.agent(ev('GET', `/api/v1/agent/sessions/${sid}/experiment-runs/${runId}`, { caller: wsCaller(sid) })));
      expect(polled).toMatchObject({ runId, status: 'uploaded', validity: { status: 'pending-crosscheck' } });
      expect(body(await rt.agent(ev('GET', `/api/v1/agent/sessions/${sid}/experiment-runs/01JA3M2C8Y3T5Q6W7E8R9T0Y1U`, { caller: wsCaller(sid) }))).code).toBe('RUN_NOT_FOUND');
      // 04 §7.4 step 3 regression: times outside the registered window are kept but invalid (OUT_OF_WINDOW), never counted
      const reg2 = body(await rt.agent(ev('POST', `/api/v1/agent/sessions/${sid}/experiment-runs`, { caller: wsCaller(sid), body: { module: 'queue', experiment: 'burst', label: 'before' } })));
      const run2 = reg2.runId as string;
      const win = reg2.window as { notBefore: string; notAfter: string };
      expect(Date.parse(win.notAfter)).toBeGreaterThan(Date.parse(win.notBefore));
      const outside = withDigest({ ...experimentResult(sid, run2), startedAt: '2026-10-14T00:00:00Z', finishedAt: '2026-10-14T01:30:00Z' });
      const up2 = await rt.agent(ev('PUT', `/api/v1/agent/sessions/${sid}/experiment-runs/${run2}/result`, { caller: wsCaller(sid), body: outside }));
      expect(up2.statusCode, up2.body).toBe(202);
      expect(body(up2)).toEqual({ runId: run2, status: 'invalid', validity: { status: 'invalid', reasons: ['OUT_OF_WINDOW'] } });
      const polled2 = body(await rt.agent(ev('GET', `/api/v1/agent/sessions/${sid}/experiment-runs/${run2}`, { caller: wsCaller(sid) })));
      expect(polled2).toMatchObject({ status: 'uploaded', validity: { status: 'invalid', reasons: ['OUT_OF_WINDOW'] } });
      const att = body(await rt.agent(ev('POST', `/api/v1/agent/sessions/${sid}/experiment-runs/${runId}/attachments`, { caller: wsCaller(sid), body: { name: 'k6-summary.json', size: 1000 } })));
      expect(att).toMatchObject({ key: `experiments/${sid}/${runId}/k6-summary.json`, method: 'PUT' });
      // browser side sees the run across sessions and per session
      expect(body(await rt.api(ev('GET', `/api/v1/sessions/${sid}/experiment-runs`, { token: OBSERVER }))).items).toHaveLength(2);
      await rt.api(ev('GET', '/api/v1/me', { token: LEARNER }));
      const detail = body(await rt.api(ev('GET', `/api/v1/experiment-runs/${runId}`, { token: LEARNER })));
      expect(detail).toMatchObject({ runId, download: { url: expect.stringContaining(`experiments/${sid}/${runId}.json`) } });
      expect(body(await rt.api(ev('GET', '/api/v1/experiment-runs?module=queue&experiment=burst', { token: ASSISTANT }))).items).toHaveLength(2);
      // module-op report from the workstation
      const mop = body(await rt.agent(ev('POST', `/api/v1/agent/sessions/${sid}/module-ops`, { caller: wsCaller(sid), body: { phase: 'started', op: 'enable', moduleId: 'queue' } })));
      await rt.agent(ev('POST', `/api/v1/agent/sessions/${sid}/module-ops`, { caller: wsCaller(sid), body: { opId: mop.opId, phase: 'finished', op: 'enable', moduleId: 'queue', exitCode: 0 } }));
      const ops = body(await rt.api(ev('GET', `/api/v1/sessions/${sid}/module-ops`, { token: OBSERVER })));
      expect(ops.items).toEqual([expect.objectContaining({ opId: mop.opId, source: 'agent', exitCode: 0 })]);
      // the workstation cannot rewrite the outcome of a platform action (or a runner op) it sees in the list
      const platformOp = '01JB3M2C8Y3T5Q6W7E8R9T0Y1P';
      await rt.repos.table.put({ ...Keys.moduleOp(sid, platformOp), type: 'ModuleOp', ver: 1, opId: platformOp, source: 'platform', op: 'set', moduleId: 'queue', startedAt: '2026-10-14T01:00:00.000Z', finishedAt: '2026-10-14T01:02:00.000Z', exitCode: 1, summary: 'failed' });
      const tamper = await rt.agent(ev('POST', `/api/v1/agent/sessions/${sid}/module-ops`, { caller: wsCaller(sid), body: { opId: platformOp, phase: 'finished', op: 'set', moduleId: 'queue', exitCode: 0, summary: 'ok' } }));
      expect(tamper.statusCode).toBe(409);
      expect(body(tamper).code).toBe('INVALID_STATE');
      expect(await rt.repos.sessions.getChild(Keys.moduleOp(sid, platformOp))).toMatchObject({ source: 'platform', exitCode: 1, summary: 'failed' });
      expect(rt.bus.published.filter((e) => JSON.stringify(e.detail).includes(platformOp))).toEqual([]);
      // wrong caller
      expect(body(await rt.agent(ev('GET', `/api/v1/agent/sessions/${sid}/context`, { caller: wsCaller('s0000000000a0') }))).code).toBe('SESSION_MISMATCH');
    });

    it('internal routes: runner progress, credential grant, module-op report', async () => {
      const sid = await startReady(rt);
      const runId = `${sid}-apply-1-0`;
      const r = await rt.agent(ev('POST', `/api/v1/internal/runs/${runId}/events`, { caller: provCaller(sid), body: { lines: [{ module: 'queue', resource: { logicalId: 'Queue' }, status: 'CREATE_IN_PROGRESS', moduleIndex: 1, moduleTotal: 2 }, { module: 'queue', status: 'CREATE_COMPLETE' }] } }));
      expect(r.statusCode, r.body).toBe(204);
      const rr = await rt.repos.sessions.getChild(Keys.runnerRun(sid, runId));
      expect(rr).toMatchObject({ runId, op: 'profile-apply', attempt: 1, progress: { module: 'queue', status: 'CREATE_COMPLETE' } });
      const g = await rt.agent(ev('POST', `/api/v1/internal/runs/${runId}/credential-grant`, { caller: provCaller(sid), body: {} }));
      expect(body(g)).toMatchObject({ channel: 'prov-profile-apply', roleSessionName: `atl-${sid}-prov-profile-apply` });
      expect(body(await rt.agent(ev('POST', `/api/v1/internal/runs/${runId}/credential-grant`, { caller: provCaller(sid), body: {} }))).grantId).toBe(body(g).grantId);
      expect(body(await rt.agent(ev('POST', `/api/v1/internal/runs/${runId}/events`, { caller: wsCaller(sid), body: {} }))).code).toBe('CALLER_MISMATCH');
      const mop = await rt.agent(ev('POST', `/api/v1/internal/sessions/${sid}/module-ops`, { caller: provCaller(sid, 'module-op'), body: { phase: 'finished', op: 'disable', moduleId: 'queue', exitCode: 3 } }));
      expect(mop.statusCode).toBe(202);
      rt.clock.advance(3000);
      const types = (body(await rt.api(ev('GET', `/api/v1/sessions/${sid}/events`, { token: LEARNER }))).events as { type: string }[]).map((e) => e.type);
      expect(types.filter((t) => t === 'session.progress')).toHaveLength(2);
      expect(types).toContain('module_op.failed');
    });

    it('quiz: draw without answers, save, grade, badge best score', async () => {
      const start = await rt.api(ev('POST', `/api/v1/labs/${LAB_ID}/quiz-attempts`, { token: LEARNER, body: {} }));
      expect(start.statusCode, start.body).toBe(201);
      const a = body(start);
      expect(a.questions).toHaveLength(2);
      expect(JSON.stringify(a)).not.toContain('answer');
      expect(JSON.stringify(a)).not.toContain('explain');
      const id = a.attemptId as string;
      expect(body(await rt.api(ev('PUT', `/api/v1/quiz-attempts/${id}/answers`, { token: LEARNER, body: { answers: { q1: ['z'] } } }))).code).toBe('VALIDATION_FAILED');
      await rt.api(ev('PUT', `/api/v1/quiz-attempts/${id}/answers`, { token: LEARNER, body: { answers: { q1: ['a'], q2: ['b', 'a'] } } }));
      const graded = body(await rt.api(ev('POST', `/api/v1/quiz-attempts/${id}/submit`, { token: LEARNER, body: {} })));
      expect(graded).toMatchObject({ score: 100, correct: 2, total: 2, byService: { sqs: { correct: 2, total: 2 } } });
      expect(body(await rt.api(ev('POST', `/api/v1/quiz-attempts/${id}/submit`, { token: LEARNER, body: {} }))).code).toBe('INVALID_STATE');
      expect((await rt.api(ev('POST', `/api/v1/labs/${LAB_ID}/quiz-attempts`, { token: OBSERVER, body: {} }))).statusCode).toBe(403);
    });

    it('reports, shares and certificates are requested from atl-certs; public routes', async () => {
      const sid = await startReady(rt);
      expect((await rt.api(ev('GET', `/api/v1/sessions/${sid}/report`, { token: LEARNER }))).statusCode).toBe(404);
      expect((await rt.api(ev('POST', `/api/v1/sessions/${sid}/report`, { token: LEARNER, body: {} }))).statusCode).toBe(202);
      const nowIso = new Date(rt.clock.nowMs()).toISOString();
      const { Gsi1 } = await import('@atl/shared');
      await rt.repos.table.put({ ...Keys.report(sid, 1), ...Gsi1.report('u-learner', nowIso, sid), type: 'Report', ver: 1, version: 1, labId: LAB_ID, generatedAt: nowIso, status: 'ready', s3Keys: { json: `reports/${sid}/v1.json`, html: `reports/${sid}/v1.html` } });
      const rep = body(await rt.api(ev('GET', `/api/v1/sessions/${sid}/report`, { token: OBSERVER })));
      expect(rep).toMatchObject({ version: 1, downloads: { html: { url: expect.stringContaining(`reports/${sid}/v1.html`) } }, revisions: [{ version: 1 }] });
      // export: atl-certs renders the masked copy first; the authoritative report keys are never signed for an export
      const rendering = await rt.api(ev('GET', `/api/v1/sessions/${sid}/report/export?format=json`, { token: LEARNER }));
      expect(rendering.statusCode).toBe(202);
      expect(body(rendering)).toMatchObject({ status: 'rendering', mask: 'on', format: 'json' });
      await rt.repos.table.update(Keys.report(sid, 1), { set: { exports: { jsonMasked: `exports/${sid}/report-v1-jsonMasked.json` } } });
      const ready = body(await rt.api(ev('GET', `/api/v1/sessions/${sid}/report/export?format=json`, { token: LEARNER })));
      expect(ready).toMatchObject({ status: 'ready', mask: 'on', download: { url: expect.stringContaining(`exports/${sid}/report-v1-jsonMasked.json`) } });
      expect(JSON.stringify(ready)).not.toContain(`reports/${sid}/v1.json`);
      expect((await rt.api(ev('GET', `/api/v1/sessions/${sid}/report/export?format=json&mask=off`, { token: LEARNER }))).statusCode).toBe(202);
      expect((await rt.api(ev('GET', `/api/v1/sessions/${sid}/report/export?format=html&mask=off`, { token: LEARNER }))).statusCode).toBe(202);
      expect((await rt.api(ev('GET', `/api/v1/sessions/${sid}/report/export?format=html&mask=nope`, { token: LEARNER }))).statusCode).toBe(400);
      await rt.api(ev('GET', '/api/v1/me', { token: LEARNER }));
      expect(body(await rt.api(ev('GET', `/api/v1/reports?labId=${LAB_ID}`, { token: ASSISTANT }))).items).toHaveLength(1);
      const share = body(await rt.api(ev('POST', `/api/v1/sessions/${sid}/report/shares`, { token: LEARNER, body: { expiresInDays: 7 } })));
      expect(share).toMatchObject({ status: 'publishing', expiresAt: '2026-10-21T01:00:00.000Z', shareId: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/) });
      expect(share.url).toBe(`/share/${String(share.shareId)}/index.html`);
      expect(body(await rt.api(ev('POST', `/api/v1/sessions/${sid}/report/shares`, { token: LEARNER, body: { expiresInHours: 24 } }))).code).toBe('VALIDATION_FAILED');
      const cert = await rt.api(ev('POST', '/api/v1/certificates', { token: LEARNER, body: { scope: 'track', trackId: 'saa-main' } }));
      expect(cert.statusCode).toBe(422);
      expect(body(cert)).toMatchObject({ code: 'CERT_NOT_ELIGIBLE', reasons: [{ code: 'REQUIRED_CARD_MISSING', labId: LAB_ID }, { code: 'GROUP_PICK_UNMET', groupId: 'g1' }] });
      // progress with valid badges → eligible → atl-certs IssueCertificate
      for (const labId of [LAB_ID, 'sc-decoupling']) {
        await rt.repos.table.put({ ...Keys.labProgress('u-learner', labId), type: 'LabProgress', ver: 1, labId, status: 'completed', attempts: 1, badge: { level: 'verified', status: 'valid', evidenceScore: 1 } });
      }
      const ok = await rt.api(ev('POST', '/api/v1/certificates', { token: LEARNER, body: { scope: 'track', trackId: 'saa-main' } }));
      expect(ok.statusCode, ok.body).toBe(201);
      expect(body(ok)).toMatchObject({ certId: 'ATL-7K2M-9Q4X-1ABZ-C3DE', jws: 'eyJ.test.sig' });
      expect(ok.headers?.location).toBe('/api/v1/certificates/ATL-7K2M-9Q4X-1ABZ-C3DE');
      const labCert = body(await rt.api(ev('POST', '/api/v1/certificates', { token: LEARNER, body: { scope: 'lab', labId: LAB_ID } })));
      expect(labCert).toMatchObject({ code: 'CERT_NOT_ELIGIBLE', reasons: [{ code: 'LAB_CERTIFICATES_DISABLED', labId: LAB_ID }] });
      await rt.flush();
      expect(rt.calls.map((c) => c.payload.action)).toEqual(expect.arrayContaining(['GenerateReport', 'ExportReport', 'CreateShare', 'IssueCertificate']));
      // atl-certs uses the id and expiry the API returned (the link in the response is the real one)
      expect(rt.calls.find((c) => c.payload.action === 'CreateShare')?.payload).toMatchObject({ sessionId: sid, shareId: share.shareId, expiresAt: share.expiresAt, revision: 1 });
      expect(rt.calls.filter((c) => c.payload.action === 'ExportReport').map((c) => [c.payload.format, c.payload.mask, c.payload.revision])).toEqual([
        ['json', 'on', 1],
        ['json', 'off', 1],
        ['html', 'off', 1],
      ]);
      expect(rt.calls.find((c) => c.payload.action === 'IssueCertificate')?.payload).toMatchObject({ scope: 'track', trackId: 'saa-main', sub: 'u-learner', labs: [LAB_ID, 'sc-decoupling'] });
      await rt.repos.table.put({ ...Keys.certificate('ATL-7K2M-9Q4X-1ABZ-C3DE'), ...(await import('@atl/shared')).Gsi1.certificate('u-learner', nowIso, 'ATL-7K2M-9Q4X-1ABZ-C3DE'), type: 'Certificate', ver: 1, certId: 'ATL-7K2M-9Q4X-1ABZ-C3DE', sub: 'u-learner', status: 'valid', scope: 'track', trackId: 'saa-main', issuedAt: nowIso, kid: 'kid-0123456789abcdef', jws: 'eyJ.test.sig' });
      expect(body(await rt.api(ev('GET', '/api/v1/certificates', { token: OBSERVER }))).items).toEqual([expect.objectContaining({ certId: 'ATL-7K2M-9Q4X-1ABZ-C3DE', status: 'valid' })]);
      const bundle = await rt.api(ev('GET', '/api/v1/certificates/ATL-7K2M-9Q4X-1ABZ-C3DE/offline-bundle', { token: LEARNER }));
      expect(body(bundle)).toMatchObject({ schema: 'atl.offline-verify/v1', jws: 'eyJ.test.sig', jwks: { keys: [] }, verifyScript: expect.any(String) });
      expect(rt.calls.find((c) => c.payload.action === 'OfflineBundle')?.payload).toMatchObject({ certId: 'ATL-7K2M-9Q4X-1ABZ-C3DE', sub: 'u-learner' });
      const revoked = await rt.api(ev('POST', '/api/v1/certificates/ATL-7K2M-9Q4X-1ABZ-C3DE/revoke', { token: LEARNER, body: { reason: 'learner-request' } }));
      expect(body(revoked)).toMatchObject({ status: 'revoked', reason: 'learner-request' });
      // atl-public is the certs-owned view (publicCertificateView): no JWS and no name unless the learner made it public
      const pubCert = body(await rt.pub(ev('GET', '/api/v1/public/certificates/ATL-7K2M-9Q4X-1ABZ-C3DE')));
      expect(pubCert).toMatchObject({ certId: 'ATL-7K2M-9Q4X-1ABZ-C3DE', status: 'valid', scope: 'track' });
      expect(pubCert).not.toHaveProperty('jws');
      expect(body(await rt.api(ev('GET', '/api/v1/me/mastery', { token: LEARNER }))).services).toEqual([expect.objectContaining({ id: 'sqs', level: 'mastered' })]);
      expect(body(await rt.api(ev('GET', '/api/v1/me/progress', { token: OBSERVER })))).toMatchObject({ tracks: [{ trackId: 'saa-main', completed: true, eligible: true }], subject: { displayName: 'u-learner' } });
      // public
      expect(body(await rt.pub(ev('GET', '/api/v1/public/health')))).toMatchObject({ status: 'ok' });
      expect((await rt.pub(ev('GET', '/api/v1/public/certificates/ATL-0000-0000-0000-0000'))).statusCode).toBe(404);
      expect(body(await rt.pub(ev('GET', '/api/v1/public/keys')))).toEqual({ keys: [] });
    });

    it('maintenance and uninstall', async () => {
      expect(body(await rt.api(ev('POST', '/api/v1/platform/maintenance', { token: LEARNER, body: { on: true } })))).toMatchObject({ maintenance: true });
      const q = body(await rt.api(ev('POST', `/api/v1/labs/${LAB_ID}/quotes`, { token: LEARNER, body: { purpose: 'START' } })));
      expect(body(await rt.api(ev('POST', '/api/v1/sessions', { token: LEARNER, body: { labId: LAB_ID, quoteId: q.quoteId, costAcknowledged: true } }))).code).toBe('MAINTENANCE_MODE');
      const status = body(await rt.api(ev('GET', '/api/v1/platform/uninstall/status', { token: LEARNER })));
      expect(status).toMatchObject({ ready: true, blockers: [] });
      expect((await rt.api(ev('POST', '/api/v1/platform/uninstall/prepare', { token: `dev.learner.u-learner.${Math.floor(rt.clock.nowMs() / 1000) - 4000}`, body: {} }))).statusCode).toBe(403);
      const prep = await rt.api(ev('POST', '/api/v1/platform/uninstall/prepare', { token: LEARNER, body: {} }));
      expect(body(prep)).toMatchObject({ execution: 'uninstall-1', alreadyRunning: false });
      expect(body(await rt.api(ev('POST', '/api/v1/platform/uninstall/prepare', { token: LEARNER, body: {} })))).toMatchObject({ execution: 'uninstall-1', alreadyRunning: true });
      const members = body(await rt.api(ev('GET', '/api/v1/members', { token: LEARNER })));
      expect(members.items).toEqual([]);
      expect((await rt.api(ev('POST', '/api/v1/members', { token: LEARNER, body: { email: 'ta@example.com', role: 'assistant' } }))).statusCode).toBe(501);
    });
  });
}

export type { JwtPrincipal };
