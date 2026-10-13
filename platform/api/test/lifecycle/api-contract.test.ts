/**
 * The lifecycle actions as atl-api's lifecycle client calls them (services/sessions/lifecycle-client.ts): CreateSession
 * with the session draft, Transition returning the session item (T04, T07, T08) and ExtendKeep (T13).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ExecutionNames } from '@atl/shared';
import { cardFixture, createHarness, SUB, type Harness } from './support/harness.js';

let h: Harness;
afterEach(async () => {
  await h?.close();
});

describe('atl-api lifecycle client contract', () => {
  it('CreateSession with the API draft (identifiers + session) writes REQUESTED and starts start-<sid>', async () => {
    h = await createHarness();
    await h.putQuote('q-api');
    const sid = 's0123456789ab';
    const draft = { sid, sub: SUB, labId: 'svc-queue', variant: 'default', costQuote: { quoteId: 'q-api', acknowledgedAt: new Date(h.clock.nowMs()).toISOString() }, cardSnapshot: cardFixture(), workstation: { mode: 'ec2' } };
    const r = await h.lifecycle<{ sessionId: string; state: string; ver: number }>({ action: 'CreateSession', sessionId: sid, sub: SUB, labId: 'svc-queue', variant: 'default', quoteId: 'q-api', reuseEnvId: null, session: draft, actor: 'user', requestedBy: { sub: SUB } });
    expect(r).toMatchObject({ sessionId: sid, state: 'REQUESTED', ver: 1 });
    const d = await h.waitExecution('atl-session-start', ExecutionNames.start(sid));
    expect(d.status).toBe('SUCCEEDED');
    // T07 through Transition returns the item the API keeps using
    const item = await h.lifecycle<Record<string, unknown>>({ action: 'Transition', sessionId: sid, from: ['READY'], to: 'RUNNING', reason: 'WORKBENCH_OPENED', actor: 'user' });
    expect(item).toMatchObject({ sid, state: 'RUNNING' });
  }, 30_000);

  it('T04 cancel through Transition and ExtendKeep with expectedKeepVersion', async () => {
    h = await createHarness();
    // cancel: a REQUESTED session whose start never ran
    await h.putQuote('q-c');
    const c = await h.lifecycle<{ sessionId: string }>({ action: 'CreateSession', sub: SUB, labId: 'svc-queue', quoteId: 'q-c', costAcknowledged: true, card: cardFixture(), startExecution: false, actor: 'user' });
    const cancelled = await h.lifecycle<Record<string, unknown>>({ action: 'Transition', sessionId: c.sessionId, from: ['REQUESTED'], to: 'ENDED', reason: 'CANCELLED', actor: 'user' });
    expect(cancelled).toMatchObject({ sid: c.sessionId, state: 'ENDED' });

    const r = await h.start();
    expect((await h.sim.waitFor(r.startArn)).status).toBe('SUCCEEDED');
    await h.putQuote(`qk-${r.sid}`, { purpose: 'KEEP', sessionId: r.sid });
    await h.lifecycle({ action: 'RequestEnd', sessionId: r.sid, disposition: 'keep', keepHours: 4, quoteId: `qk-${r.sid}`, when: 'now', actor: 'user' });
    await h.waitExecution('atl-session-end', ExecutionNames.endFirst(r.sid));
    await h.putQuote('qke', { purpose: 'KEEP', sessionId: r.sid });
    await expect(h.lifecycle({ action: 'ExtendKeep', sessionId: r.sid, hours: 4, quoteId: 'qke', expectedKeepVersion: 2 })).rejects.toMatchObject({ name: 'Atl.PreconditionFailed' });
    const ok = await h.lifecycle<{ keepVersion: number }>({ action: 'ExtendKeep', sessionId: r.sid, hours: 4, quoteId: 'qke', expectedKeepVersion: 1 });
    expect(ok.keepVersion).toBe(2);
  }, 30_000);
});
