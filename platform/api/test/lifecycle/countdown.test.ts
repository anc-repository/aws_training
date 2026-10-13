/**
 * Countdown (02 §5): one-time schedules on whole minutes, WARN_15 → EXPIRING, WARN_5, EXPIRE → end with EXPIRED,
 * extensions (new version first, old deleted, limits), ready-idle, early triggers, sweeper reconciliation.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ExecutionNames, ScheduleNames } from '@atl/shared';
import { createHarness, type Harness } from './support/harness.js';

let h: Harness;
afterEach(async () => {
  await h?.close();
});

async function ready(card: Record<string, unknown> = {}) {
  const r = await h.start({}, card);
  expect((await h.sim.waitFor(r.startArn)).status).toBe('SUCCEEDED');
  await h.lifecycle({ action: 'Heartbeat', sessionId: r.sid, workbench: true });
  return r.sid;
}

describe('expiry (no learner action)', () => {
  it('WARN_15 → EXPIRING, WARN_5 warning, EXPIRE → ENDING → ENDED (EXPIRED), never before deadlineAt', async () => {
    h = await createHarness();
    const sid = await ready();
    const deadline = Date.parse((await h.session(sid)).deadlineAt!);
    const end = await h.waitExecution('atl-session-end', ExecutionNames.endFirst(sid)).catch(async () => {
      await h.until(async () => !!h.sim.listExecutions().find((e) => e.name === ExecutionNames.endFirst(sid)), 4 * 3_600_000);
      return h.waitExecution('atl-session-end', ExecutionNames.endFirst(sid));
    });
    expect(end.status).toBe('SUCCEEDED');
    const s = await h.session(sid);
    expect(s.state).toBe('ENDED');
    expect(s.endReason).toBe('EXPIRED');
    const fired = h.scheduler.fired.filter((f) => 'sessionId' in f.payload && f.payload.sessionId === sid);
    const byKind = Object.fromEntries(fired.map((f) => [f.payload.kind, f]));
    expect(byKind.WARN_15!.firedAt).toBe(deadline - 15 * 60_000);
    expect(byKind.WARN_5!.firedAt).toBe(deadline - 5 * 60_000);
    expect(byKind.EXPIRE!.firedAt).toBeGreaterThanOrEqual(deadline);
    const events = (await h.query(`SESSION#${sid}`, 'EVT#')).map((e) => `${e.type}${(e.data as { to?: string }).to ? `:${(e.data as { to?: string }).to}` : ''}`);
    expect(events).toEqual(expect.arrayContaining(['session.state_changed:EXPIRING', 'session.expiry_warning', 'session.state_changed:ENDING', 'session.state_changed:ENDED']));
    expect(events.filter((e) => e === 'session.expiry_warning')).toHaveLength(2);
  }, 30_000);

  it('a session that is never opened ends after readyIdleMinutes (IDLE_NOT_STARTED)', async () => {
    h = await createHarness();
    const r = await h.start();
    await h.sim.waitFor(r.startArn);
    await h.until(async () => !!h.sim.listExecutions().find((e) => e.name === ExecutionNames.endFirst(r.sid)), 2 * 3_600_000);
    await h.waitExecution('atl-session-end', ExecutionNames.endFirst(r.sid));
    const s = await h.session(r.sid);
    expect(s.endReason).toBe('IDLE_NOT_STARTED');
    expect(Date.parse(s.endedAt!) - Date.parse(s.readyAt!)).toBeLessThan(90 * 60_000);
  });
});

describe('extensions (02 §5.4)', () => {
  it('extends by whole minutes, creates version N+1 before deleting N, and enforces the count limit', async () => {
    h = await createHarness();
    const sid = await ready();
    const s0 = await h.session(sid);
    await h.putQuote('qx1', { purpose: 'EXTEND', sessionId: sid });
    const r1 = await h.lifecycle<{ deadlineVersion: number; deadlineAt: string }>({ action: 'Extend', sessionId: sid, minutes: 30, quoteId: 'qx1', expectedDeadlineVersion: 1 });
    expect(r1.deadlineVersion).toBe(2);
    expect(Date.parse(r1.deadlineAt) - Date.parse(s0.deadlineAt!)).toBe(30 * 60_000);
    const names = h.scheduler.list().map((x) => x.name);
    expect(names).toEqual(expect.arrayContaining([ScheduleNames.expire(sid, 2), ScheduleNames.warn15(sid, 2)]));
    expect(names).not.toContain(ScheduleNames.expire(sid, 1));
    // a wrong-purpose quote is refused
    await h.putQuote('qk', { purpose: 'KEEP', sessionId: sid });
    await expect(h.lifecycle({ action: 'Extend', sessionId: sid, minutes: 10, quoteId: 'qk', expectedDeadlineVersion: 2 })).rejects.toMatchObject({ name: 'Atl.QuoteMismatch' });
    // stale version
    await h.putQuote('qx2', { purpose: 'EXTEND', sessionId: sid });
    await expect(h.lifecycle({ action: 'Extend', sessionId: sid, minutes: 30, quoteId: 'qx2', expectedDeadlineVersion: 1 })).rejects.toMatchObject({ name: 'Atl.PreconditionFailed' });
    // too long
    await expect(h.lifecycle({ action: 'Extend', sessionId: sid, minutes: 45, quoteId: 'qx2', expectedDeadlineVersion: 2 })).rejects.toMatchObject({ name: 'Atl.ExtensionLimit' });
    await h.lifecycle({ action: 'Extend', sessionId: sid, minutes: 30, quoteId: 'qx2', expectedDeadlineVersion: 2 });
    await h.putQuote('qx3', { purpose: 'EXTEND', sessionId: sid });
    await expect(h.lifecycle({ action: 'Extend', sessionId: sid, minutes: 30, quoteId: 'qx3', expectedDeadlineVersion: 3 })).rejects.toMatchObject({ name: 'Atl.ExtensionLimit' });
  });

  it('extending from EXPIRING goes back to RUNNING (T09) and the session expires at the new deadline', async () => {
    h = await createHarness();
    const sid = await ready();
    const deadline = Date.parse((await h.session(sid)).deadlineAt!);
    await h.until(async () => (await h.session(sid)).state === 'EXPIRING', 3 * 3_600_000);
    await h.putQuote('qx', { purpose: 'EXTEND', sessionId: sid, expiresAt: new Date(h.clock.nowMs() + 15 * 60_000).toISOString() });
    await h.lifecycle({ action: 'Extend', sessionId: sid, minutes: 30, quoteId: 'qx', expectedDeadlineVersion: 1 });
    expect((await h.session(sid)).state).toBe('RUNNING');
    await h.until(async () => !!h.sim.listExecutions().find((e) => e.name === ExecutionNames.endFirst(sid)), 3 * 3_600_000);
    await h.waitExecution('atl-session-end', ExecutionNames.endFirst(sid));
    const fired = h.scheduler.fired.filter((f) => f.payload.kind === 'EXPIRE' && 'sessionId' in f.payload && f.payload.sessionId === sid);
    expect(fired.map((f) => f.name)).toEqual([ScheduleNames.expire(sid, 2)]);
    expect(fired[0]!.firedAt).toBe(deadline + 30 * 60_000);
    expect((await h.session(sid)).endReason).toBe('EXPIRED');
  }, 30_000);

  it('MaxSessionMinutes caps the total (card limits can only tighten the platform)', async () => {
    h = await createHarness({ config: { limits: { maxSessionMinutes: 100, extension: { minutes: 30, maxCount: 2 } } } });
    const sid = await ready();
    await h.putQuote('qx', { purpose: 'EXTEND', sessionId: sid });
    await expect(h.lifecycle({ action: 'Extend', sessionId: sid, minutes: 30, quoteId: 'qx', expectedDeadlineVersion: 1 })).rejects.toMatchObject({ name: 'Atl.ExtensionLimit' });
  });
});

describe('early triggers and the sweeper safety net', () => {
  it('an early EXPIRE is re-triggered one minute later (exp-v<N>-r<k>), not dropped', async () => {
    h = await createHarness();
    const sid = await ready();
    const r = await h.timer<{ dropped: boolean; retriggered: boolean }>({ kind: 'EXPIRE', sessionId: sid, deadlineVersion: 1 });
    expect(r).toMatchObject({ dropped: false, retriggered: true });
    expect(h.scheduler.list().map((x) => x.name)).toContain(ScheduleNames.expire(sid, 1, 1));
    expect((await h.timer({ kind: 'EXPIRE', sessionId: sid, deadlineVersion: 9 })).dropped).toBe(true); // old version
  });

  it('SWEEP re-creates a missing schedule of the current version and ends a session whose EXPIRE never arrived', async () => {
    h = await createHarness();
    const sid = await ready();
    await h.deps.ports.scheduler.delete(ScheduleNames.expire(sid, 1), 'atl-sessions');
    const rep = await h.timer<{ actions: { action: string; detail?: string }[] }>({ kind: 'SWEEP' });
    expect(rep.actions.filter((a) => a.action === 'schedule-recreated').map((a) => a.detail)).toContain(ScheduleNames.expire(sid, 1));
    // lose it again and let time pass beyond deadline + 2 minutes
    await h.deps.ports.scheduler.delete(ScheduleNames.expire(sid, 1), 'atl-sessions');
    await h.deps.ports.scheduler.delete(ScheduleNames.warn5(sid, 1), 'atl-sessions');
    const deadline = Date.parse((await h.session(sid)).deadlineAt!);
    // block reconciliation by removing the sweeper's chance before the deadline: jump right past it
    h.clock.advance(deadline - h.clock.nowMs() + 3 * 60_000);
    const rep2 = await h.timer<{ actions: { action: string }[] }>({ kind: 'SWEEP' });
    expect(rep2.actions.map((a) => a.action)).toContain('expired-late');
    await h.waitExecution('atl-session-end', ExecutionNames.endFirst(sid));
    expect((await h.session(sid)).endReason).toBe('EXPIRED');
  });

  it('SWEEP fails a REQUESTED session after 5 minutes (START_TIMEOUT) and disables itself when idle', async () => {
    h = await createHarness({ faults: [{ state: 'ValidateQuote', error: 'Atl.Retryable', times: 50 }] });
    const r = await h.start();
    h.clock.advance(6 * 60_000);
    await h.timer({ kind: 'SWEEP' });
    const s = await h.session(r.sid);
    expect(s.state).toBe('FAILED');
    expect(s.failure).toMatchObject({ code: 'START_TIMEOUT' });
    const rep = await h.timer<{ disabled: boolean }>({ kind: 'SWEEP' });
    expect(rep.disabled).toBe(true);
    expect((await h.scheduler.get('atl-sweeper', 'atl-system'))?.state).toBe('DISABLED');
  });
});
