/**
 * Platform uninstall (02 §10.5, 01 §4.8): UNINSTALLING refuses new sessions; every session is ended and every kept
 * environment released; CLEANUP_FAILED sessions get one retry; the guard run answers CloudFormation through
 * UninstallRoleCleanup (SUCCESS, or FAILED when BLOCKING residue remains).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ExecutionNames } from '@atl/shared';
import { createHarness, type Harness } from './support/harness.js';

let h: Harness;
afterEach(async () => {
  await h?.close();
});

const REGION = 'ap-northeast-1';
const CFN = { responseUrl: 'https://cfn.example/response', requestId: 'r-1', stackId: 'arn:aws:cloudformation:ap-northeast-1:000000000000:stack/atl/x', logicalResourceId: 'UninstallGuard', physicalResourceId: 'atl-uninstall-guard' };

async function readySession() {
  const r = await h.start();
  expect((await h.sim.waitFor(r.startArn)).status).toBe('SUCCEEDED');
  await h.lifecycle({ action: 'Heartbeat', sessionId: r.sid, workbench: true });
  return r.sid;
}

function learnerCreate(sid: string, id: string) {
  const at = new Date(h.clock.nowMs() - 60_000).toISOString();
  h.trail.inject({
    eventId: `ev-${id}`,
    eventName: 'CreateDBInstance',
    eventTime: at,
    eventSource: 'rds.amazonaws.com',
    region: REGION,
    username: `atl-${sid}-console`,
    readOnly: false,
    resources: [{ resourceType: 'AWS::RDS::DBInstance', resourceName: id }],
    cloudTrailEvent: JSON.stringify({
      eventID: `ev-${id}`,
      eventName: 'CreateDBInstance',
      eventSource: 'rds.amazonaws.com',
      awsRegion: REGION,
      eventTime: at,
      userIdentity: { type: 'AssumedRole', arn: `arn:aws:sts::000000000000:assumed-role/ATLLearnerRole/atl-${sid}-console`, sessionContext: { sessionIssuer: { arn: 'arn:aws:iam::000000000000:role/ATLLearnerRole' } } },
      requestParameters: { dBInstanceIdentifier: id },
      responseElements: { dBInstanceIdentifier: id, dBInstanceArn: `arn:aws:rds:${REGION}:000000000000:db:${id}` },
    }),
  });
}

describe('atl-platform-uninstall', () => {
  it('guard: refuses new sessions, ends the running session, then calls UninstallRoleCleanup with SUCCESS', async () => {
    h = await createHarness();
    const sid = await readySession();
    const { executionArn } = await h.orchestrator.startExecution({ stateMachine: 'atl-platform-uninstall', name: ExecutionNames.uninstall(1), input: { trigger: 'guard', cfn: CFN } });
    const d = await h.sim.waitFor(executionArn);
    expect(d.status).toBe('SUCCEEDED');
    const s = await h.session(sid);
    expect(s.state).toBe('ENDED');
    expect(s.endReason).toBe('PLATFORM_UNINSTALL');
    expect(h.dev.roleCleanups).toEqual([{ action: 'UninstallRoleCleanup', cfn: CFN, outcome: 'SUCCESS', reason: 'all sessions reclaimed' }]);
    const cfg = await h.item({ PK: 'PLATFORM', SK: 'CONFIG' });
    expect(cfg).toMatchObject({ mode: 'UNINSTALLING', uninstall: { outcome: 'SUCCESS', trigger: 'guard' } });
    // while uninstalling no new session can start, and no keep / extension is accepted
    await expect(h.start()).rejects.toMatchObject({ name: 'Atl.PlatformUninstalling' });
  }, 30_000);

  it('prepare: releases a kept environment, retries a CLEANUP_FAILED once, and fails with the BLOCKING residue (no role clean-up)', async () => {
    h = await createHarness();
    const sid = await readySession();
    h.dev.reclaim.addResource({ type: 'AWS::RDS::DBInstance', region: REGION, id: 'cloudalbum-db-protected', behaviour: { kind: 'protected' } });
    learnerCreate(sid, 'cloudalbum-db-protected');
    await h.putQuote(`qk-${sid}`, { purpose: 'KEEP', sessionId: sid });
    await h.lifecycle({ action: 'RequestEnd', sessionId: sid, disposition: 'keep', keepHours: 4, quoteId: `qk-${sid}`, when: 'now', actor: 'user' });
    expect((await h.waitExecution('atl-session-end', ExecutionNames.endFirst(sid))).status).toBe('SUCCEEDED');
    expect((await h.session(sid)).state).toBe('KEPT');

    const { executionArn } = await h.orchestrator.startExecution({ stateMachine: 'atl-platform-uninstall', name: ExecutionNames.uninstall(1), input: { trigger: 'prepare', requestedBy: 'admin' } });
    const d = await h.sim.waitFor(executionArn);
    expect(d.status).toBe('FAILED');
    expect(d.error).toBe('Atl.UninstallBlocked');
    expect(d.cause).toContain('BLOCKING');
    const s = await h.session(sid);
    expect(s.state).toBe('CLEANUP_FAILED');
    expect(s.uninstallRetried).toBe(true);
    const names = h.sim.listExecutions().map((e) => e.name);
    expect(names).toEqual(expect.arrayContaining([ExecutionNames.endRelease(sid), ExecutionNames.endRetry(sid, 1)]));
    expect(names).not.toContain(ExecutionNames.endRetry(sid, 2)); // one retry only
    expect(h.dev.roleCleanups).toEqual([]);
    expect(await h.item({ PK: 'PLATFORM', SK: 'CONFIG' })).toMatchObject({ uninstall: { outcome: 'FAILED', trigger: 'prepare' } });
  }, 30_000);
});
