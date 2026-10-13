/**
 * Report share links end to end (04 §9.5): POST /report/shares → atl-certs CreateShare (the id and expiry the API
 * returned) → GET /report/shares → DELETE (revoke) → the expiry schedule fires → atl-timer → atl-certs ExpireShare.
 * Real route handlers, atl-certs and atl-timer over the in-memory table; the schedule is fired by the test at its `at`.
 * Also: exports are rendered and recorded by atl-certs (only masked copies are signed by default), retries of
 * CreateShare never publish a second copy.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { Keys, ScheduleNames, WebKeys, type OneTimeScheduleRequest, type ScheduleGroup, type ScheduleInfo, type SchedulerPort } from '@atl/shared';
import { createCertsHandler } from '../src/functions/certs/handler.js';
import { primeContentCache } from '../src/functions/checks/engine/facts.js';
import { createTimerHandler } from '../src/functions/timer/handler.js';
import { body, createApiTestRuntime, ev, LEARNER, type ApiTestRuntime } from './api-support/api-runtime.js';
import { CATALOG, LAB_ID, testCard } from './checks-support/card.js';

const SID = 's4k7m2q9x1abc';
const DAY = 86_400_000;

/** EventBridge Scheduler as far as shares need it: name conflicts are not errors, the test fires due schedules. */
class TestScheduler implements SchedulerPort {
  readonly entries = new Map<string, OneTimeScheduleRequest>();
  creates = 0;
  async createOneTime(req: OneTimeScheduleRequest) {
    this.creates++;
    if (this.entries.has(req.name)) return { created: false };
    this.entries.set(req.name, req);
    return { created: true };
  }
  async delete(name: string) {
    this.entries.delete(name);
  }
  async get(name: string, group: ScheduleGroup): Promise<ScheduleInfo | null> {
    const e = this.entries.get(name);
    return e ? { name, group, state: 'ENABLED', at: e.at.toISOString(), payload: e.payload } : null;
  }
  async setSweeperEnabled() {}
}

let rt: ApiTestRuntime;
let scheduler: TestScheduler;
let invalidated: string[];

async function settle(): Promise<void> {
  for (let i = 0; i < 30; i++) await rt.flush();
}

/** What EventBridge Scheduler does at `at`: invoke atl-timer with the payload (ActionAfterCompletion DELETE). */
async function fireDue(): Promise<string[]> {
  const fired: string[] = [];
  for (const [name, e] of [...scheduler.entries]) {
    if (e.at.getTime() > rt.clock.nowMs()) continue;
    scheduler.entries.delete(name);
    await rt.invoker.invoke('atl-timer', e.payload);
    fired.push(name);
  }
  await settle();
  return fired;
}

const webText = (key: string) => {
  const b = rt.objects.objects.get(`${rt.deps.env.buckets.web}/${key}`);
  return b ? new TextDecoder().decode(b) : null;
};

beforeEach(async () => {
  rt = await createApiTestRuntime();
  scheduler = new TestScheduler();
  invalidated = [];
  (rt.deps.ports as { scheduler: SchedulerPort }).scheduler = scheduler;
  const getDeps = async () => rt.deps;
  rt.invoker.register('atl-certs', createCertsHandler(getDeps, {}, { invalidator: () => async (paths) => void invalidated.push(...paths) }));
  rt.invoker.register('atl-timer', createTimerHandler(getDeps));
  primeContentCache(CATALOG, LAB_ID, testCard());
  const now = new Date(rt.clock.nowMs()).toISOString();
  await rt.repos.table.put({
    ...Keys.labSession(SID),
    type: 'LabSession',
    ver: 3,
    createdAt: '2026-10-13T06:50:00.000Z',
    updatedAt: now,
    sid: SID,
    sub: 'u-learner',
    labId: LAB_ID,
    labKind: 'service',
    variant: 'default',
    catalogVersion: CATALOG,
    envId: '01jc9x3k9cq4m2x8n5b6c0d1e2',
    state: 'ENDED',
    readyAt: '2026-10-13T07:00:00.000Z',
    endedAt: '2026-10-13T08:30:00.000Z',
    endReason: 'USER_ENDED',
    startProfile: `atl/${LAB_ID}/default`,
  });
  await rt.repos.table.put({ ...Keys.labAttempt(SID), type: 'LabAttempt', ver: 1, createdAt: now, updatedAt: now, status: 'completed', completedAt: '2026-10-13T08:00:00.000Z', checksSummary: { auto: 1, manual: 0, failed: 0 } });
  // the report the shares and exports are made from (atl-certs GenerateReport, revision 1)
  const gen = await rt.invoker.invoke<{ revision: number }>('atl-certs', { action: 'GenerateReport', sessionId: SID, reason: 'finalize' });
  expect(gen.revision).toBe(1);
});

describe('report share links (04 §9.5): create → list → revoke → expire', () => {
  it('the link the API returns is the one atl-certs publishes; revoke removes it, the schedule expires the other', async () => {
    // create (7 days)
    const res = await rt.api(ev('POST', `/api/v1/sessions/${SID}/report/shares`, { token: LEARNER, body: { expiresInDays: 7 } }));
    expect(res.statusCode, res.body).toBe(202);
    const a = body<{ shareId: string; url: string; expiresAt: string; status: string }>(res);
    expect(a.shareId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(a.url).toBe(`/share/${a.shareId}/index.html`);
    expect(a.expiresAt).toBe(new Date(rt.clock.nowMs() + 7 * DAY).toISOString());
    await settle();
    expect(rt.invoker.asyncErrors).toEqual([]);
    expect(webText(`${WebKeys.share(a.shareId)}index.html`)).toContain('脱敏报告副本');
    expect(webText(`${WebKeys.share(a.shareId)}report.json`)).toBeTruthy();
    // its expiry schedule (atl-system, at the expiry rounded up to the minute)
    const sched = scheduler.entries.get(ScheduleNames.shareExpire(a.shareId));
    expect(sched).toMatchObject({ group: 'atl-system', payload: { kind: 'SHARE_EXPIRE', shareId: a.shareId } });
    expect(sched!.at.getTime()).toBe(Math.ceil(Date.parse(a.expiresAt) / 60_000) * 60_000);

    // list
    const list1 = body<{ items: Record<string, unknown>[] }>(await rt.api(ev('GET', `/api/v1/sessions/${SID}/report/shares`, { token: LEARNER })));
    expect(list1.items).toEqual([expect.objectContaining({ shareId: a.shareId, status: 'active', expiresAt: a.expiresAt, url: a.url, revision: 1 })]);
    expect(list1.items[0]).not.toHaveProperty('objectKeys');

    // revoke with the real id (22 characters, mixed case, - and _)
    const del = await rt.api(ev('DELETE', `/api/v1/sessions/${SID}/report/shares/${a.shareId}`, { token: LEARNER }));
    expect(del.statusCode, del.body).toBe(202);
    await settle();
    expect(webText(`${WebKeys.share(a.shareId)}index.html`)).toBeNull();
    expect(webText(`${WebKeys.share(a.shareId)}report.json`)).toBeNull();
    expect(invalidated).toContain(`/share/${a.shareId}/*`);
    expect(scheduler.entries.has(ScheduleNames.shareExpire(a.shareId))).toBe(false);
    const list2 = body<{ items: Record<string, unknown>[] }>(await rt.api(ev('GET', `/api/v1/sessions/${SID}/report/shares`, { token: LEARNER })));
    expect(list2.items).toEqual([expect.objectContaining({ shareId: a.shareId, status: 'revoked', revokedAt: expect.any(String) })]);
    // revoking again is a no-op; an unknown id is 404
    expect(body(await rt.api(ev('DELETE', `/api/v1/sessions/${SID}/report/shares/${a.shareId}`, { token: LEARNER })))).toMatchObject({ status: 'revoked' });
    expect((await rt.api(ev('DELETE', `/api/v1/sessions/${SID}/report/shares/AAAAAAAAAAAAAAAAAAAAAA`, { token: LEARNER }))).statusCode).toBe(404);

    // a second link expires through the schedule: atl-timer → atl-certs ExpireShare
    const b = body<{ shareId: string; expiresAt: string }>(await rt.api(ev('POST', `/api/v1/sessions/${SID}/report/shares`, { token: LEARNER, body: { expiresInDays: 7 } })));
    await settle();
    expect(webText(`${WebKeys.share(b.shareId)}index.html`)).toBeTruthy();
    expect(await fireDue()).toEqual([]); // not due yet
    rt.clock.advance(7 * DAY + 60_000);
    expect(await fireDue()).toEqual([ScheduleNames.shareExpire(b.shareId)]);
    expect(rt.invoker.asyncErrors).toEqual([]);
    expect(rt.invoker.log.some((l) => l.fn === 'atl-certs' && (l.payload as { action?: string }).action === 'ExpireShare')).toBe(true);
    expect(webText(`${WebKeys.share(b.shareId)}index.html`)).toBeNull();
    expect(invalidated).toContain(`/share/${b.shareId}/*`);
    const list3 = body<{ items: Record<string, unknown>[] }>(await rt.api(ev('GET', `/api/v1/sessions/${SID}/report/shares`, { token: LEARNER })));
    expect(list3.items.find((i) => i.shareId === b.shareId)).toMatchObject({ status: 'expired', revokeReason: 'expired' });
    // no share copy is left in atl-web
    expect([...rt.objects.objects.keys()].filter((k) => k.startsWith(`${rt.deps.env.buckets.web}/share/`))).toEqual([]);
  });

  it('a never-expiring link has no schedule; CreateShare retries publish one copy only; a retry after revocation publishes nothing', async () => {
    const res = body<{ shareId: string; expiresAt: string | null }>(await rt.api(ev('POST', `/api/v1/sessions/${SID}/report/shares`, { token: LEARNER, body: { expiresInDays: null } })));
    expect(res.expiresAt).toBeNull();
    await settle();
    expect(scheduler.entries.size).toBe(0);
    // Lambda's async retries deliver the same payload again
    const payload = rt.invoker.log.find((l) => l.fn === 'atl-certs' && (l.payload as { action?: string }).action === 'CreateShare')!.payload;
    await rt.invoker.invoke('atl-certs', payload);
    await rt.invoker.invoke('atl-certs', payload);
    const copies = [...rt.objects.objects.keys()].filter((k) => k.startsWith(`${rt.deps.env.buckets.web}/share/`));
    expect(copies.sort()).toEqual([`${rt.deps.env.buckets.web}/share/${res.shareId}/index.html`, `${rt.deps.env.buckets.web}/share/${res.shareId}/report.json`]);
    expect((await rt.repos.sessions.children(SID, 'SHARE#', { all: true })).items).toHaveLength(1);

    // an expiring link retried: one schedule, one record
    const exp = body<{ shareId: string }>(await rt.api(ev('POST', `/api/v1/sessions/${SID}/report/shares`, { token: LEARNER, body: {} })));
    await settle();
    const p2 = rt.invoker.log.filter((l) => l.fn === 'atl-certs' && (l.payload as { action?: string }).action === 'CreateShare').at(-1)!.payload as Record<string, unknown>;
    expect(p2.shareId).toBe(exp.shareId);
    expect(Date.parse(String(p2.expiresAt)) - rt.clock.nowMs()).toBe(30 * DAY); // default 30 days
    await rt.invoker.invoke('atl-certs', p2);
    expect(scheduler.entries.size).toBe(1);
    expect(scheduler.creates).toBe(2);

    await rt.api(ev('DELETE', `/api/v1/sessions/${SID}/report/shares/${res.shareId}`, { token: LEARNER }));
    await settle();
    const late = await rt.invoker.invoke<{ status: string; created: boolean }>('atl-certs', payload);
    expect(late).toMatchObject({ status: 'revoked', created: false });
    expect(webText(`${WebKeys.share(res.shareId)}index.html`)).toBeNull();
  });

  it('rejects an expiresAt atl-certs was not meant to accept (past or beyond 90 days)', async () => {
    const id = 'Zm9vYmFyYmF6cXV4cXV1eA';
    await expect(rt.invoker.invoke('atl-certs', { action: 'CreateShare', sessionId: SID, shareId: id, expiresAt: new Date(rt.clock.nowMs() - 1000).toISOString() })).rejects.toThrow(/expiresAt/);
    await expect(rt.invoker.invoke('atl-certs', { action: 'CreateShare', sessionId: SID, shareId: id, expiresAt: new Date(rt.clock.nowMs() + 200 * DAY).toISOString() })).rejects.toThrow(/expiresAt/);
    expect(webText(`${WebKeys.share(id)}index.html`)).toBeNull();
  });
});

describe('report export (04 §9.4): atl-certs renders and records the copies; atl-api signs only those', () => {
  it('masked by default, unmasked on request, never the authoritative keys', async () => {
    // seed an account ID and a public IP into the report evidence path: the masked export must not contain them
    const first = await rt.api(ev('GET', `/api/v1/sessions/${SID}/report/export?format=json`, { token: LEARNER }));
    expect(first.statusCode).toBe(202);
    await settle();
    expect(rt.invoker.asyncErrors).toEqual([]);
    const rep = await rt.repos.sessions.latestReport(SID);
    expect(rep?.exports).toEqual({ jsonMasked: `exports/${SID}/report-v1-jsonMasked.json` });
    const ready = body<{ status: string; download: { url: string } }>(await rt.api(ev('GET', `/api/v1/sessions/${SID}/report/export?format=json`, { token: LEARNER })));
    expect(ready.status).toBe('ready');
    expect(ready.download.url).toContain(`exports/${SID}/report-v1-jsonMasked.json`);
    const masked = new TextDecoder().decode(rt.objects.objects.get(`${rt.deps.env.buckets.data}/exports/${SID}/report-v1-jsonMasked.json`)!);
    expect(masked).toContain('masked copy');
    expect(masked).not.toContain(rt.deps.env.accountId);

    // mask=off: its own copy, recorded next to the masked one
    expect((await rt.api(ev('GET', `/api/v1/sessions/${SID}/report/export?format=html&mask=off`, { token: LEARNER }))).statusCode).toBe(202);
    await settle();
    const off = body<{ status: string; download: { url: string } }>(await rt.api(ev('GET', `/api/v1/sessions/${SID}/report/export?format=html&mask=off`, { token: LEARNER })));
    expect(off.download.url).toContain(`exports/${SID}/report-v1-htmlUnmasked.html`);
    expect((await rt.repos.sessions.latestReport(SID))?.exports).toEqual({ jsonMasked: `exports/${SID}/report-v1-jsonMasked.json`, htmlUnmasked: `exports/${SID}/report-v1-htmlUnmasked.html` });
  });
});
