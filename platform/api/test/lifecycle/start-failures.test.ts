/**
 * Start workflow failures (02 §4.5, §12): refusals before PROVISIONING (no resources, T03), runner failure
 * classification and retries, the health-gate repair, compensation through atl-session-end (T06 → FAILED), cancel.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ExecutionNames, Keys } from '@atl/shared';
import { createHarness, type Harness } from './support/harness.js';

let h: Harness;
afterEach(async () => {
  await h?.close();
});

async function runStart(over: Record<string, unknown> = {}) {
  const r = await h.start(over);
  const d = await h.sim.waitFor(r.startArn);
  return { ...r, start: d };
}

async function endOf(sid: string) {
  return h.waitExecution('atl-session-end', ExecutionNames.endFirst(sid));
}

describe('refusals before PROVISIONING (T03: no resources, lock untouched)', () => {
  it('an expired quote fails the start with QUOTE_EXPIRED', async () => {
    h = await createHarness();
    const { sid, start } = await runStart({ quote: { expiresAt: new Date(Date.UTC(2026, 9, 14, 0, 0, 0)).toISOString() } });
    expect(start.status).toBe('FAILED');
    expect(start.error).toBe('Atl.StartRejected');
    const s = await h.session(sid);
    expect(s.state).toBe('FAILED');
    expect(s.failure).toMatchObject({ code: 'QUOTE_EXPIRED' });
    expect(h.runner.started).toHaveLength(0);
    expect(await h.item(Keys.activeEnvironmentLock())).toBeNull();
  });

  it('a second session while one is active is refused: fast pre-check (409) and the authoritative AcquireLock (LOCK_BUSY)', async () => {
    // a transient fault delays ValidateQuote of both executions, so both requests pass the non-authoritative pre-check
    // (the lock is still free) and AcquireLock decides
    h = await createHarness({ faults: [{ state: 'ValidateQuote', error: 'Lambda.ServiceException', times: 2 }] });
    const x = await h.start();
    const y = await h.start();
    const [xd, yd] = await Promise.all([h.sim.waitFor(x.startArn), h.sim.waitFor(y.startArn)]);
    const [a, b] = xd.status === 'SUCCEEDED' ? [x, y] : [y, x];
    expect([xd.status, yd.status].sort()).toEqual(['FAILED', 'SUCCEEDED']);
    expect((await h.session(b.sid)).failure).toMatchObject({ code: 'LOCK_BUSY' });
    expect((await h.session(a.sid)).state).toBe('READY');
    expect(await h.item(Keys.activeEnvironmentLock())).toMatchObject({ holderSessionId: a.sid });
    // a third request is refused at once by CreateSession (API 409 SESSION_ACTIVE_EXISTS)
    await expect(h.start()).rejects.toMatchObject({ name: 'Atl.SessionActiveExists' });
  });

  it('a failed account preflight (e.g. no default VPC) fails before any resource is created', async () => {
    h = await createHarness();
    h.checks.preflight = { result: 'FAIL', failureCode: 'PREFLIGHT_NO_DEFAULT_VPC', items: [{ id: 'default-vpc', level: 'FAIL', message: 'no default VPC' }] };
    const { sid, start } = await runStart();
    expect(start.status).toBe('FAILED');
    expect((await h.session(sid)).failure).toMatchObject({ code: 'PREFLIGHT_NO_DEFAULT_VPC' });
    expect(h.runner.started).toHaveLength(0);
    expect(await h.item(Keys.activeEnvironmentLock())).toMatchObject({ holderSessionId: null });
  });

  it('cancel in REQUESTED ends the session (T04) and stops the start workflow', async () => {
    h = await createHarness({ faults: [{ state: 'Preflight', error: 'Atl.Retryable', times: 3 }] });
    const { sid, startArn } = await h.start();
    const r = await h.lifecycle<{ state: string }>({ action: 'RequestEnd', sessionId: sid, disposition: 'destroy', when: 'now', actor: 'user' });
    expect(r.state).toBe('ENDED');
    const d = await h.sim.waitFor(startArn);
    expect(['ABORTED', 'SUCCEEDED']).toContain(d.status);
    const s = await h.session(sid);
    expect(s.state).toBe('ENDED');
    expect(s.endReason).toBe('CANCELLED');
    expect(h.runner.started).toHaveLength(0);
  });
});

describe('runner failures, retries and compensation', () => {
  it('a throttled base-deploy is retried once and the session gets READY', async () => {
    h = await createHarness();
    h.runner.fail('base-deploy', { exitCode: 3, cfnFailures: [{ stack: 's', logicalId: 'Instance', status: 'CREATE_FAILED', reason: 'Rate exceeded' }] });
    const { sid, start } = await runStart();
    expect(start.status).toBe('SUCCEEDED');
    expect((await h.session(sid)).state).toBe('READY');
    expect(h.runner.ops().filter((o) => o.startsWith('base-deploy'))).toEqual([`base-deploy:${sid}-base-1`, `base-deploy:${sid}-base-2`]);
    const run = await h.item(Keys.runnerRun(sid, `${sid}-base-1`));
    expect(run?.classification).toMatchObject({ retryable: true });
  });

  it('a non-retryable failure (AccessDenied) is compensated: atl-session-end reclaims and the session is FAILED', async () => {
    h = await createHarness();
    h.runner.fail('profile-apply', { exitCode: 3, cfnFailures: [{ stack: 's', logicalId: 'Queue', status: 'CREATE_FAILED', reason: 'User is not authorized to perform sqs:CreateQueue' }] });
    const { sid, start } = await runStart();
    expect(start.status).toBe('FAILED');
    expect(start.error).toBe('Atl.ProvisionFailed');
    const end = await endOf(sid);
    expect(end.status).toBe('SUCCEEDED');
    const s = await h.session(sid);
    expect(s.state).toBe('FAILED');
    expect(s.endReason).toBe('PROVISION_FAILED');
    expect(s.failure).toMatchObject({ code: 'ACCESS_DENIED' });
    expect(h.runner.ops().filter((o) => o.startsWith('profile-apply'))).toHaveLength(1); // not retried
    // compensation = the normal reclaim path: base / workstation stacks and out-of-band resources are gone
    expect([...h.dev.reclaim.resources.keys()]).toEqual([]);
    expect(h.runner.ops().map((o) => o.split(':')[0])).toEqual(expect.arrayContaining(['workstation-down', 'destroy']));
    expect(await h.item(Keys.activeEnvironmentLock())).toMatchObject({ holderSessionId: null });
    expect(h.dev.lifecycle.revocations.revoked[sid]).toBeTruthy();
  });

  it('PROFILE_DIGEST_MISMATCH (exit 2) is never retried', async () => {
    h = await createHarness();
    h.runner.fail('profile-apply', { exitCode: 2, classificationCode: 'PROFILE_DIGEST_MISMATCH' });
    const { sid } = await runStart();
    await endOf(sid);
    expect((await h.session(sid)).failure).toMatchObject({ code: 'PROFILE_DIGEST_MISMATCH' });
    expect(h.runner.ops().filter((o) => o.startsWith('profile-apply'))).toHaveLength(1);
  });

  it('a missing result.json (infrastructure error) is retryable', async () => {
    h = await createHarness();
    h.runner.fail('profile-apply', { noResult: true, exitCode: 1 });
    const { sid, start } = await runStart();
    expect(start.status).toBe('SUCCEEDED');
    expect(h.runner.ops().filter((o) => o.startsWith('profile-apply'))).toEqual([`profile-apply:${sid}-apply-1-0`, `profile-apply:${sid}-apply-2-0`]);
  });

  it('the health gate repairs once (profile-apply with ATL_REPAIR=1) and then passes', async () => {
    h = await createHarness();
    h.checks.health.push(...Array.from({ length: 7 }, () => ({ status: 'NOT_READY', message: 'caps.profile degraded' })));
    const { sid, start } = await runStart();
    expect(start.status).toBe('SUCCEEDED');
    expect(h.runner.ops().filter((o) => o.startsWith('profile-apply'))).toEqual([`profile-apply:${sid}-apply-1-0`, `profile-apply:${sid}-apply-1-1`]);
    expect(h.runner.started.find((r) => r.runId === `${sid}-apply-1-1`)?.repair).toBe(true);
  });

  it('a health gate that keeps failing after the repair compensates with HEALTH_FAILED', async () => {
    h = await createHarness();
    h.checks.health.push(...Array.from({ length: 2 }, () => ({ status: 'FAIL', message: 'base.ready failed' })));
    const { sid, start } = await runStart();
    expect(start.status).toBe('FAILED');
    await endOf(sid);
    const s = await h.session(sid);
    expect(s.state).toBe('FAILED');
    expect(s.failure).toMatchObject({ code: 'HEALTH_FAILED' });
  });

  it('a failed workstation setup compensates with WORKSTATION_FAILED', async () => {
    h = await createHarness();
    h.runCommand.next.push('Failed', 'Failed', 'Failed');
    const { sid, start } = await runStart();
    expect(start.status).toBe('FAILED');
    await endOf(sid);
    expect((await h.session(sid)).failure).toMatchObject({ code: 'WORKSTATION_FAILED' });
    expect(h.runCommand.sent.filter((c) => c.documentName === 'ATL-WorkstationSetup')).toHaveLength(3);
  });

  it('an instance that never registers with SSM is rebooted once and then compensated with SSM_NOT_REGISTERED', async () => {
    h = await createHarness();
    h.dev.lifecycle.rebootFixesPing = false;
    // the lab instance will be i-dev-<envName>-lab: make every instance offline
    const origPing = h.dev.lifecycle.ssmPing.bind(h.dev.lifecycle);
    h.dev.lifecycle.ssmPing = async (ids: string[]) => Object.fromEntries(Object.keys(await origPing(ids)).map((id) => [id, 'ConnectionLost' as const]));
    const { sid, start } = await runStart();
    expect(start.status).toBe('FAILED');
    await endOf(sid);
    const s = await h.session(sid);
    expect(s.failure).toMatchObject({ code: 'SSM_NOT_REGISTERED' });
    expect(h.dev.lifecycle.reboots.length).toBeGreaterThan(0);
  });

  it('transient Lambda faults are retried by the ASL (fault injection)', async () => {
    h = await createHarness({ faults: [{ state: 'AcquireLock', error: 'Lambda.ServiceException', times: 2 }, { state: 'CaptureLedger', error: 'Atl.Retryable', times: 1 }] });
    const { sid, start } = await runStart();
    expect(start.status).toBe('SUCCEEDED');
    expect((await h.session(sid)).state).toBe('READY');
    expect(h.sim.history.filter((e) => e.type === 'FaultInjected')).toHaveLength(3);
  });

  it('cancel during PROVISIONING stops the start workflow and reclaims (T06 → CLEANING → ENDED, CANCELLED)', async () => {
    h = await createHarness({ runner: { seconds: 600 } });
    const { sid, startArn } = await h.start();
    await h.until(async () => (await h.session(sid)).state === 'PROVISIONING', 3_600_000, 5_000);
    await h.lifecycle({ action: 'RequestEnd', sessionId: sid, disposition: 'destroy', when: 'now', actor: 'user' });
    const end = await endOf(sid);
    expect(end.status).toBe('SUCCEEDED');
    expect((await h.sim.waitFor(startArn)).status).toBe('ABORTED');
    const s = await h.session(sid);
    expect(s.state).toBe('ENDED');
    expect(s.endReason).toBe('CANCELLED');
    expect(h.runner.list().some((b) => b.status === 'STOPPED')).toBe(true);
  });
});
