/**
 * Reclaim failures (02 §6.7, §7.5–§7.9, T18–T21): BLOCKING residue → CLEANUP_FAILED with the manual-handling list,
 * the residualAck rule for the next start, retry (T19) and “我已处理” (T20), the delayed rescan downgrade (T21),
 * workflow errors (EmergencyConclude) and the sweeper's automatic retries.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ExecutionNames, Keys } from '@atl/shared';
import { createHarness, type Harness } from './support/harness.js';

let h: Harness;
afterEach(async () => {
  await h?.close();
});

const REGION = 'ap-northeast-1';

async function readySession() {
  const r = await h.start();
  expect((await h.sim.waitFor(r.startArn)).status).toBe('SUCCEEDED');
  await h.lifecycle({ action: 'Heartbeat', sessionId: r.sid, workbench: true });
  return r.sid;
}

function learnerCreate(sid: string, opts: { id: string; atMs: number; eventId: string }) {
  const at = new Date(opts.atMs).toISOString();
  h.trail.inject({
    eventId: opts.eventId,
    eventName: 'CreateDBInstance',
    eventTime: at,
    eventSource: 'rds.amazonaws.com',
    region: REGION,
    username: `atl-${sid}-console`,
    readOnly: false,
    resources: [{ resourceType: 'AWS::RDS::DBInstance', resourceName: opts.id }],
    cloudTrailEvent: JSON.stringify({
      eventID: opts.eventId,
      eventName: 'CreateDBInstance',
      eventSource: 'rds.amazonaws.com',
      awsRegion: REGION,
      eventTime: at,
      userIdentity: { type: 'AssumedRole', arn: `arn:aws:sts::000000000000:assumed-role/ATLLearnerRole/atl-${sid}-console`, sessionContext: { sessionIssuer: { arn: 'arn:aws:iam::000000000000:role/ATLLearnerRole' } } },
      requestParameters: { dBInstanceIdentifier: opts.id },
      responseElements: { dBInstanceIdentifier: opts.id, dBInstanceArn: `arn:aws:rds:${REGION}:000000000000:db:${opts.id}` },
    }),
  });
}

describe('BLOCKING residue → CLEANUP_FAILED', () => {
  it('lists the resource for manual handling, releases the lock, requires residualAck, and a retry (T19) finishes the job', async () => {
    h = await createHarness();
    const sid = await readySession();
    h.dev.reclaim.addResource({ type: 'AWS::RDS::DBInstance', region: REGION, id: 'cloudalbum-db-protected', behaviour: { kind: 'protected' } });
    learnerCreate(sid, { id: 'cloudalbum-db-protected', atMs: h.clock.nowMs() - 60_000, eventId: 'ev-db-1' });
    await h.lifecycle({ action: 'RequestEnd', sessionId: sid, disposition: 'destroy', when: 'now' });
    await h.waitExecution('atl-session-end', ExecutionNames.endFirst(sid));
    let s = await h.session(sid);
    expect(s.state).toBe('CLEANUP_FAILED');
    expect(s.cleanup).toMatchObject({ blocking: 1, hourlyBlocking: 1 });
    expect(await h.item(Keys.activeEnvironmentLock())).toMatchObject({ holderSessionId: null }); // released even when CLEANUP_FAILED
    expect(await h.item(Keys.environment(s.envId!))).toMatchObject({ status: 'RELEASE_FAILED' });
    const items = await h.query(`ENV#${s.envId}`, 'RES#');
    const db = items.find((i) => i.id === 'cloudalbum-db-protected')!;
    expect(db).toMatchObject({ cleanupState: 'MANUAL_REQUIRED', severity: 'BLOCKING', billing: 'hourly', discoveredBy: 'CLOUDTRAIL', creatorSessionName: `atl-${sid}-console`, GSI2PK: 'RES#MANUAL_REQUIRED' });
    expect(db.manualHint).toMatchObject({ cli: expect.stringContaining('cloudalbum-db-protected') });
    expect(h.dev.lifecycle.notifications.some((n) => n.topic === 'atl-alerts')).toBe(true);
    const events = (await h.query(`SESSION#${sid}`, 'EVT#')).map((e) => e.type);
    expect(events).toEqual(expect.arrayContaining(['reclaim.item_manual', 'cleanup.failed']));

    // a new start needs residualAck (02 §9.2, default policy ack)
    const b = await h.start();
    await h.sim.waitFor(b.startArn);
    expect((await h.session(b.sid)).failure).toMatchObject({ code: 'LOCK_BUSY' });
    expect((await h.session(b.sid)).failure?.message).toContain('residualAck');

    // the learner fixes it; a retry finishes (T19 → CLEANING → T16 ENDED)
    h.dev.reclaim.resources.get(`AWS::RDS::DBInstance|${REGION}|cloudalbum-db-protected`)!.behaviour = { kind: 'ok' };
    // the retry needs the item planned again: MANUAL items are re-tried by a RETRY pass
    const r = await h.lifecycle<{ executionArn: string; retry: number }>({ action: 'RetryCleanup', sessionId: sid, actor: 'user' });
    expect(r.retry).toBe(1);
    await h.waitExecution('atl-session-end', ExecutionNames.endRetry(sid, 1));
    s = await h.session(sid);
    expect(s.state).toBe('ENDED');
    expect(h.dev.reclaim.has('AWS::RDS::DBInstance', REGION, 'cloudalbum-db-protected')).toBe(false);
  }, 30_000);

  it('“我已处理”: a resource the learner deleted by hand is re-checked and the session returns to its terminal state (T20)', async () => {
    h = await createHarness();
    const sid = await readySession();
    h.dev.reclaim.addResource({ type: 'AWS::RDS::DBInstance', region: REGION, id: 'cloudalbum-db-x', behaviour: { kind: 'denied' } });
    learnerCreate(sid, { id: 'cloudalbum-db-x', atMs: h.clock.nowMs() - 60_000, eventId: 'ev-db-2' });
    await h.lifecycle({ action: 'RequestEnd', sessionId: sid, disposition: 'destroy', when: 'now' });
    await h.waitExecution('atl-session-end', ExecutionNames.endFirst(sid));
    const s0 = await h.session(sid);
    expect(s0.state).toBe('CLEANUP_FAILED');
    const item = (await h.query(`ENV#${s0.envId}`, 'RES#')).find((i) => i.id === 'cloudalbum-db-x')!;
    // still there → not resolved
    let r = await h.lifecycle<{ resolved: boolean; remainingBlocking: number; state: string }>({ action: 'ResolveCleanup', sessionId: sid, resourceKey: item.resourceKey });
    expect(r).toMatchObject({ resolved: false, remainingBlocking: 1, state: 'CLEANUP_FAILED' });
    h.dev.reclaim.resources.delete(`AWS::RDS::DBInstance|${REGION}|cloudalbum-db-x`);
    r = await h.lifecycle({ action: 'ResolveCleanup', sessionId: sid, resourceKey: item.resourceKey });
    expect(r).toMatchObject({ resolved: true, remainingBlocking: 0, state: 'ENDED' });
    expect((await h.item(Keys.sessionResource(s0.envId!, String(item.resourceKey))))?.cleanupState).toBe('RESOLVED_BY_LEARNER');
  });
});

describe('delayed rescans (7.7) and T21', () => {
  it('a creation event that arrives late is found by a rescan; BLOCKING downgrades ENDED → CLEANUP_FAILED', async () => {
    h = await createHarness({ trailDelaySeconds: 30 * 60 }); // delivered 30 minutes late
    const sid = await readySession();
    h.dev.reclaim.addResource({ type: 'AWS::RDS::DBInstance', region: REGION, id: 'cloudalbum-db-late', behaviour: { kind: 'protected' } });
    learnerCreate(sid, { id: 'cloudalbum-db-late', atMs: h.clock.nowMs() - 60_000, eventId: 'ev-late' });
    await h.lifecycle({ action: 'RequestEnd', sessionId: sid, disposition: 'destroy', when: 'now' });
    await h.waitExecution('atl-session-end', ExecutionNames.endFirst(sid));
    let s = await h.session(sid);
    expect(s.state).toBe('ENDED'); // the primary pass could not see the event yet
    expect(s.reclaim?.followUp).toBe('PENDING');
    const rescan = await h.waitExecution('atl-reclaim-rescan', ExecutionNames.rescan(s.envId!));
    expect(rescan.status).toBe('SUCCEEDED');
    s = await h.session(sid);
    expect(s.state).toBe('CLEANUP_FAILED');
    expect(s.reclaim?.followUp).toBe('DONE');
    const changes = (await h.query(`SESSION#${sid}`, 'EVT#')).filter((e) => e.type === 'session.state_changed').map((e) => e.data as { from: string; to: string; reason: string });
    // T21 inside the window (the sweeper's automatic retries keep failing on the protected instance afterwards)
    expect(changes).toContainEqual({ from: 'ENDED', to: 'CLEANUP_FAILED', reason: 'RESCAN_BLOCKING' });
    expect(await h.item(Keys.environment(s.envId!))).toMatchObject({ status: 'RELEASE_FAILED' });
  }, 30_000);
});

describe('workflow errors and automatic retries', () => {
  it('a failed reclaim execution ends in CLEANUP_FAILED (WORKFLOW_ERROR); the sweeper retries after 1 h and succeeds', async () => {
    h = await createHarness({ faults: [{ state: 'PlanDiscovery', stateMachine: 'atl-reclaim', error: 'Atl.Boom', times: 1 }] });
    const sid = await readySession();
    await h.lifecycle({ action: 'RequestEnd', sessionId: sid, disposition: 'destroy', when: 'now' });
    const end = await h.waitExecution('atl-session-end', ExecutionNames.endFirst(sid));
    expect(end.status).toBe('FAILED');
    expect(end.error).toBe('Atl.EndWorkflowError');
    let s = await h.session(sid);
    expect(s.state).toBe('CLEANUP_FAILED');
    expect(s.stateReason).toBe('WORKFLOW_ERROR');
    const unknown = (await h.query(`ENV#${s.envId}`, 'RES#')).find((i) => i.resourceType === 'ATL::Environment::Unknown');
    expect(unknown).toMatchObject({ severity: 'BLOCKING', cleanupState: 'MANUAL_REQUIRED' });
    // sweeper: nothing before 1 h, then T19 with end-<sid>-retry-1
    h.clock.advance(30 * 60_000);
    let rep = await h.timer<{ actions: { action: string }[] }>({ kind: 'SWEEP' });
    expect(rep.actions.map((a) => a.action)).not.toContain('cleanup-auto-retry');
    h.clock.advance(31 * 60_000);
    rep = await h.timer({ kind: 'SWEEP' });
    expect(rep.actions.map((a) => a.action)).toContain('cleanup-auto-retry');
    await h.waitExecution('atl-session-end', ExecutionNames.endRetry(sid, 1));
    s = await h.session(sid);
    // a complete retry pass deletes the environment's resources and settles the “state unknown” item → ENDED (T16)
    expect(s.state).toBe('ENDED');
    expect(s.autoCleanupRetries).toBe(1);
    expect([...h.dev.reclaim.resources.keys()]).toEqual([]);
    expect((await h.item(Keys.sessionResource(s.envId!, String(unknown!.resourceKey))))?.cleanupState).toBe('DELETED');
  }, 30_000);
});
