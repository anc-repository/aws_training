/**
 * Kept environments and reuse (02 §8, §3.4, T11, T13, T14, T15): keep with save mode, keep timers, extend the keep,
 * release blocked by a live reservation, hand-over to the next session in one transaction, reclaim of the whole chain.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ExecutionNames, Keys, ScheduleNames } from '@atl/shared';
import { createHarness, type Harness } from './support/harness.js';

let h: Harness;
afterEach(async () => {
  await h?.close();
});

async function readySession(over: Record<string, unknown> = {}, card: Record<string, unknown> = {}) {
  const r = await h.start(over, card);
  expect((await h.sim.waitFor(r.startArn)).status).toBe('SUCCEEDED');
  await h.lifecycle({ action: 'Heartbeat', sessionId: r.sid, workbench: true });
  return r.sid;
}

async function keepIt(sid: string, hours = 4) {
  await h.putQuote(`qk-${sid}`, { purpose: 'KEEP', sessionId: sid });
  await h.lifecycle({ action: 'RequestEnd', sessionId: sid, disposition: 'keep', keepHours: hours, quoteId: `qk-${sid}`, when: 'now', actor: 'user' });
  const end = await h.waitExecution('atl-session-end', ExecutionNames.endFirst(sid));
  expect(end.status).toBe('SUCCEEDED');
}

describe('keep (T11) and release (T14)', () => {
  it('keeps the environment with save mode, keep timers and the lock; releases at keep.until (KEEP_EXPIRED)', async () => {
    h = await createHarness({ runner: { profileStacks: { queue: [{ type: 'AWS::SQS::Queue', id: 'https://sqs/q1', logicalId: 'Queue' }] } } });
    const sid = await readySession();
    await keepIt(sid, 1);
    let s = await h.session(sid);
    expect(s.state).toBe('KEPT');
    expect(s.keep).toMatchObject({ version: 1, saveMode: true });
    expect(h.runner.ops().map((o) => o.split(':')[0])).toEqual(expect.arrayContaining(['workstation-down', 'suspend']));
    expect(h.runner.ops().map((o) => o.split(':')[0])).not.toContain('destroy');
    expect(h.scheduler.list().map((x) => x.name)).toEqual(expect.arrayContaining([ScheduleNames.keepWarn15(sid, 1), ScheduleNames.keepExpire(sid, 1)]));
    expect(await h.item(Keys.activeEnvironmentLock())).toMatchObject({ holderSessionId: sid });
    expect(await h.item(Keys.environment(s.envId!))).toMatchObject({ status: 'KEPT', saveMode: true });
    expect(h.dev.reclaim.has('AWS::SQS::Queue', 'ap-northeast-1', 'https://sqs/q1')).toBe(true);
    // a new environment cannot start while one is kept
    await expect(h.start()).rejects.toMatchObject({ name: 'Atl.EnvKeptExists' });
    // keep.until → KEEP_EXPIRE → end-<sid>-rel → CLEANING → ENDED
    await h.until(async () => !!h.sim.listExecutions().find((e) => e.name === ExecutionNames.endRelease(sid)), 3 * 3_600_000);
    expect((await h.waitExecution('atl-session-end', ExecutionNames.endRelease(sid))).status).toBe('SUCCEEDED');
    s = await h.session(sid);
    expect(s.state).toBe('ENDED');
    expect(s.stateReason).toBe('RECLAIM_VERIFIED');
    expect(h.dev.reclaim.has('AWS::SQS::Queue', 'ap-northeast-1', 'https://sqs/q1')).toBe(false);
    expect(await h.item(Keys.activeEnvironmentLock())).toMatchObject({ holderSessionId: null });
  }, 30_000);

  it('extends the keep (T13: new keep version first) and releases on request (KEEP_RELEASED)', async () => {
    h = await createHarness();
    const sid = await readySession();
    await keepIt(sid, 4);
    await h.putQuote('qke', { purpose: 'KEEP', sessionId: sid });
    const r = await h.lifecycle<{ keepVersion: number }>({ action: 'KeepExtend', sessionId: sid, hours: 4, quoteId: 'qke' });
    expect(r.keepVersion).toBe(2);
    const names = h.scheduler.list().map((x) => x.name);
    expect(names).toContain(ScheduleNames.keepExpire(sid, 2));
    expect(names).not.toContain(ScheduleNames.keepExpire(sid, 1));
    // beyond MaxKeepHours (24)
    await h.putQuote('qke2', { purpose: 'KEEP', sessionId: sid });
    await expect(h.lifecycle({ action: 'KeepExtend', sessionId: sid, hours: 20, quoteId: 'qke2' })).rejects.toMatchObject({ name: 'Atl.LimitExceeded' });
    await h.lifecycle({ action: 'ReleaseKept', sessionId: sid, actor: 'user' });
    await h.waitExecution('atl-session-end', ExecutionNames.endRelease(sid));
    const s = await h.session(sid);
    expect(s.state).toBe('ENDED');
    expect(h.scheduler.list().filter((x) => x.name.startsWith(`atl-${sid}-`))).toEqual([]);
  });

  it('a card that does not allow keeping refuses disposition=keep', async () => {
    h = await createHarness();
    const sid = await readySession({}, { retain: { allowed: false, maxHours: null } });
    await h.putQuote('qk', { purpose: 'KEEP', sessionId: sid });
    await expect(h.lifecycle({ action: 'RequestEnd', sessionId: sid, disposition: 'keep', keepHours: 1, quoteId: 'qk', when: 'now' })).rejects.toMatchObject({ name: 'Atl.KeepNotAllowed' });
  });
});

describe('reuse of a kept environment (T15 + T02 in one transaction)', () => {
  it('hands the environment over, resumes, applies additively, and the end reclaims the resources of the whole chain', async () => {
    h = await createHarness();
    const a = await readySession();
    await keepIt(a, 4);
    const envId = (await h.session(a)).envId!;
    // something the learner of A created by hand (CloudTrail evidence under atl-<A>-console)
    h.dev.reclaim.addResource({ type: 'AWS::S3::Bucket', region: 'ap-northeast-1', id: 'cloudalbum-learner-a-bucket' });
    h.trail.inject({
      eventId: 'ev-a-1',
      eventName: 'CreateBucket',
      eventTime: new Date(h.clock.nowMs() - 60_000).toISOString(),
      eventSource: 's3.amazonaws.com',
      region: 'ap-northeast-1',
      username: `atl-${a}-console`,
      readOnly: false,
      resources: [{ resourceType: 'AWS::S3::Bucket', resourceName: 'cloudalbum-learner-a-bucket' }],
      cloudTrailEvent: JSON.stringify({
        eventID: 'ev-a-1',
        eventName: 'CreateBucket',
        eventSource: 's3.amazonaws.com',
        awsRegion: 'ap-northeast-1',
        eventTime: new Date(h.clock.nowMs() - 60_000).toISOString(),
        userIdentity: { type: 'AssumedRole', arn: `arn:aws:sts::000000000000:assumed-role/ATLLearnerRole/atl-${a}-console`, sessionContext: { sessionIssuer: { arn: 'arn:aws:iam::000000000000:role/ATLLearnerRole' } } },
        requestParameters: { bucketName: 'cloudalbum-learner-a-bucket' },
        responseElements: null,
      }),
    });
    const b = await h.start({ reuseEnvironmentId: envId, quote: { purpose: 'REUSE', reuseEnvironmentId: envId } });
    expect((await h.sim.waitFor(b.startArn)).status).toBe('SUCCEEDED');
    expect((await h.session(a)).state).toBe('ENDED');
    expect((await h.session(a)).endReason).toBe('HANDED_OVER');
    const sb = await h.session(b.sid);
    expect(sb.state).toBe('READY');
    expect(sb.envId).toBe(envId);
    expect(await h.item(Keys.environment(envId))).toMatchObject({ sessionChain: [a, b.sid], ownerSessionId: b.sid });
    expect(await h.item(Keys.activeEnvironmentLock())).toMatchObject({ holderSessionId: b.sid, pendingSessionId: null });
    const bOps = h.runner.started.filter((r) => r.sessionId === b.sid);
    expect(bOps.map((r) => r.op)).toEqual(expect.arrayContaining(['resume', 'workstation-up', 'profile-apply']));
    expect(bOps.find((r) => r.op === 'profile-apply')?.applyMode).toBe('additive');
    expect(bOps.map((r) => r.op)).not.toContain('base-deploy');
    expect(h.scheduler.list().filter((x) => x.name.startsWith(`atl-${a}-`))).toEqual([]); // A's keep timers are void
    // B ends: the reclaim covers A's console session too
    await h.lifecycle({ action: 'RequestEnd', sessionId: b.sid, disposition: 'destroy', when: 'now' });
    await h.waitExecution('atl-session-end', ExecutionNames.endFirst(b.sid));
    expect((await h.session(b.sid)).state).toBe('ENDED');
    const res = await h.query(`ENV#${envId}`, 'RES#');
    expect(h.dev.reclaim.has('AWS::S3::Bucket', 'ap-northeast-1', 'cloudalbum-learner-a-bucket')).toBe(false);
    expect(res.find((r) => r.id === 'cloudalbum-learner-a-bucket')).toMatchObject({ sessionId: a, discoveredBy: 'CLOUDTRAIL', cleanupState: 'DELETED', creatorSessionName: `atl-${a}-console` });
    // both sessions of the chain are revoked
    expect(Object.keys(h.dev.lifecycle.revocations.revoked)).toEqual(expect.arrayContaining([a, b.sid]));
  }, 30_000);

  it('a live reuse reservation blocks the release of the kept environment (REUSE_IN_PROGRESS) and KEEP_EXPIRE is postponed', async () => {
    h = await createHarness();
    const a = await readySession();
    await keepIt(a, 1);
    const envId = (await h.session(a)).envId!;
    h.sim.injectFault({ state: 'Preflight', error: 'Atl.Retryable', times: 5 }); // keeps B in its reservation for a while
    const b = await h.start({ reuseEnvironmentId: envId, quote: { purpose: 'REUSE', reuseEnvironmentId: envId } });
    await h.until(async () => !!(await h.item(Keys.activeEnvironmentLock()))?.pendingSessionId, 600_000, 1_000);
    await expect(h.lifecycle({ action: 'ReleaseKept', sessionId: a })).rejects.toMatchObject({ name: 'Atl.ReuseInProgress' });
    const keep = await h.session(a);
    const r = await h.timer<{ retriggered?: boolean; dropped: boolean }>({ kind: 'KEEP_EXPIRE', sessionId: a, keepVersion: keep.keep!.version });
    expect(r.dropped).toBe(false);
    expect((await h.sim.waitFor(b.startArn)).status).toBe('SUCCEEDED');
    expect((await h.session(a)).endReason).toBe('HANDED_OVER');
  }, 30_000);
});
