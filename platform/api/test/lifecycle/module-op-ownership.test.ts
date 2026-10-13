/**
 * atl-module-op (01 §3.3, 02 §4.3, §5.8) and the targeted ownership scan OwnershipLookup (02 §7.12, 01 §3.12).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ExecutionNames, runnerRunId } from '@atl/shared';
import { OWNERSHIP_RETRY_SECONDS, retryAfterSeconds } from '../../src/functions/ownership/ownership.js';
import { createHarness, type Harness } from './support/harness.js';

let h: Harness;
afterEach(async () => {
  await h?.close();
});

const REGION = 'ap-northeast-1';

async function readySession(card: Parameters<Harness['start']>[1] = {}) {
  const r = await h.start({}, card);
  expect((await h.sim.waitFor(r.startArn)).status).toBe('SUCCEEDED');
  await h.lifecycle({ action: 'Heartbeat', sessionId: r.sid, workbench: true });
  return r.sid;
}

function bucketEvent(opts: { id: string; sessionName: string; eventId: string; atMs: number; roleName?: string }) {
  const at = new Date(opts.atMs).toISOString();
  const role = opts.roleName ?? 'ATLLearnerRole';
  h.trail.inject({
    eventId: opts.eventId,
    eventName: 'CreateBucket',
    eventTime: at,
    eventSource: 's3.amazonaws.com',
    region: REGION,
    username: opts.sessionName,
    readOnly: false,
    resources: [{ resourceType: 'AWS::S3::Bucket', resourceName: opts.id }],
    cloudTrailEvent: JSON.stringify({
      eventID: opts.eventId,
      eventName: 'CreateBucket',
      eventSource: 's3.amazonaws.com',
      awsRegion: REGION,
      eventTime: at,
      userIdentity: { type: 'AssumedRole', arn: `arn:aws:sts::000000000000:assumed-role/${role}/${opts.sessionName}`, sessionContext: { sessionIssuer: { arn: `arn:aws:iam::000000000000:role/${role}` } } },
      requestParameters: { bucketName: opts.id },
    }),
  });
}

describe('atl-module-op', () => {
  it('runs an allowed platform action (ATL_OP=module-op), opens and closes the expected-outage window', async () => {
    h = await createHarness();
    const sid = await readySession();
    const name = ExecutionNames.moduleOp(sid, 1);
    await h.orchestrator.startExecution({ stateMachine: 'atl-module-op', name, input: { sessionId: sid, actionId: 'iam-revoke-sessions', n: 1, requestedBy: 'learner-1' } });
    const d = await h.waitExecution('atl-module-op', name);
    expect(d.status).toBe('SUCCEEDED');
    expect(h.runner.ops()).toContain(`module-op:${runnerRunId(sid, 'module-op', 1)}`);
    const s = await h.session(sid);
    expect(s.moduleOpRunning ?? null).toBeNull();
    expect(s.outageWindow).toBeNull();
    const events = (await h.query(`SESSION#${sid}`, 'EVT#')).map((e) => ({ type: e.type, data: e.data as Record<string, unknown> }));
    const windows = events.filter((e) => e.type === 'session.outage_window_changed').map((e) => e.data.open);
    expect(windows).toEqual([true, false]);
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(['module_op.started', 'module_op.succeeded']));
    const ops = await h.query(`SESSION#${sid}`, 'MODOP#');
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ actionId: 'iam-revoke-sessions', status: 'SUCCEEDED', runId: runnerRunId(sid, 'module-op', 1), source: 'platform' });
  }, 30_000);

  it('refuses an action that is not on the card (Atl.ModuleOpRejected, no build)', async () => {
    h = await createHarness();
    const sid = await readySession();
    const name = ExecutionNames.moduleOp(sid, 1);
    await h.orchestrator.startExecution({ stateMachine: 'atl-module-op', name, input: { sessionId: sid, actionId: 'rm-rf', n: 1 } });
    const d = await h.waitExecution('atl-module-op', name);
    expect(d.status).toBe('FAILED');
    expect(d.error).toBe('Atl.ModuleOpRejected');
    expect(h.runner.ops().filter((o) => o.startsWith('module-op:'))).toEqual([]);
  }, 30_000);

  it('a failed build fails the op, records it, and still closes the window', async () => {
    h = await createHarness();
    const sid = await readySession();
    h.runner.fail('module-op', { exitCode: 3, error: 'module enable failed' });
    const name = ExecutionNames.moduleOp(sid, 1);
    await h.orchestrator.startExecution({ stateMachine: 'atl-module-op', name, input: { sessionId: sid, actionId: 'iam-revoke-sessions', n: 1 } });
    const d = await h.waitExecution('atl-module-op', name);
    expect(d.status).toBe('FAILED');
    expect(d.error).toBe('Atl.ModuleOpFailed');
    const s = await h.session(sid);
    expect(s.outageWindow).toBeNull();
    expect(s.moduleOpRunning ?? null).toBeNull();
    expect(s.state).toBe('RUNNING'); // a failed platform action does not end the session
    const types = (await h.query(`SESSION#${sid}`, 'EVT#')).map((e) => e.type);
    expect(types).toContain('module_op.failed');
  }, 30_000);
});

describe('OwnershipLookup', () => {
  it('cadence 2, 2, 4, 4, 8 minutes, then every 8 minutes', () => {
    expect(OWNERSHIP_RETRY_SECONDS).toEqual([120, 120, 240, 240, 480]);
    expect([0, 1, 2, 3, 4, 5, 9].map(retryAfterSeconds)).toEqual([120, 120, 240, 240, 480, 480, 480]);
  });

  it('PENDING while CloudTrail has not delivered the event, FOUND afterwards (recorded in the ledger)', async () => {
    h = await createHarness({ trailDelaySeconds: 6 * 60 });
    const sid = await readySession();
    const createdAt = h.clock.nowMs();
    bucketEvent({ id: 'my-learner-bucket', sessionName: `atl-${sid}-console`, eventId: 'ev-b1', atMs: createdAt });
    const req = { action: 'OwnershipLookup', sessionId: sid, resource: { type: 'AWS::S3::Bucket', id: 'my-learner-bucket', region: REGION }, createdAtHint: new Date(createdAt).toISOString(), scope: 'session' };
    let r = await h.reaper<Record<string, unknown>>({ ...req, attempt: 0 });
    expect(r).toMatchObject({ status: 'PENDING', retryAfterSeconds: 120 });
    h.clock.advance(7 * 60_000);
    r = await h.reaper({ ...req, attempt: 1 });
    expect(r).toMatchObject({ status: 'FOUND', sessionId: sid, roleSessionName: `atl-${sid}-console`, eventId: 'ev-b1' });
    const envId = (await h.session(sid)).envId!;
    const items = await h.query(`ENV#${envId}`, 'RES#');
    expect(items.find((i) => i.id === 'my-learner-bucket')).toMatchObject({ discoveredBy: 'OWNERSHIP_LOOKUP', creatorSessionName: `atl-${sid}-console` });
    // the second question is answered from the ledger without CloudTrail
    r = await h.reaper({ ...req, attempt: 0 });
    expect(r).toMatchObject({ status: 'FOUND', sessionId: sid });
  }, 30_000);

  it('NOT_OWNED when someone else created it; NOT_FOUND after maxWaitMinutes', async () => {
    h = await createHarness();
    const sid = await readySession();
    bucketEvent({ id: 'someone-elses-bucket', sessionName: 'alice', eventId: 'ev-b2', atMs: h.clock.nowMs() - 60_000, roleName: 'AdminRole' });
    let r = await h.reaper<Record<string, unknown>>({ action: 'OwnershipLookup', sessionId: sid, resource: { type: 'AWS::S3::Bucket', id: 'someone-elses-bucket', region: REGION }, scope: 'session' });
    expect(r).toMatchObject({ status: 'NOT_OWNED', eventId: 'ev-b2' });
    expect(String(r.actor)).toContain('alice');

    const firstQueriedAt = new Date(h.clock.nowMs()).toISOString();
    const q = { action: 'OwnershipLookup', sessionId: sid, resource: { type: 'AWS::S3::Bucket', id: 'never-created', region: REGION }, scope: 'session', firstQueriedAt, maxWaitMinutes: 20 };
    r = await h.reaper(q);
    expect(r).toMatchObject({ status: 'PENDING' });
    h.clock.advance(21 * 60_000);
    r = await h.reaper(q);
    expect(r).toEqual({ status: 'NOT_FOUND' });
  }, 30_000);
});
