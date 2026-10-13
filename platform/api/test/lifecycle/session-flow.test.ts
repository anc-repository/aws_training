/**
 * End-to-end session lifecycle in ATL_DEV_MODE style (02 §4, §5, §6, §7): the deployed ASL files run in the in-process
 * simulator against atl-lifecycle / atl-timer / atl-reaper, the scripted runner and the dev clouds.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ExecutionNames, Keys, ScheduleNames } from '@atl/shared';
import { createHarness, type Harness } from './support/harness.js';

let h: Harness;
afterEach(async () => {
  await h?.close();
});

describe('happy path: start → READY → RUNNING → end → ENDED → rescans', () => {
  it('runs the whole session and reclaims everything', async () => {
    h = await createHarness();
    const { sid, startArn } = await h.start();
    const start = await h.sim.waitFor(startArn);
    expect(start.status).toBe('SUCCEEDED');
    let s = await h.session(sid);
    expect(s.state).toBe('READY');
    expect(s.deadlineVersion).toBe(1);
    expect(Date.parse(s.deadlineAt!) % 60_000).toBe(0); // whole minute (02 §5.1)
    expect(Date.parse(s.deadlineAt!) - Date.parse(s.readyAt!)).toBeGreaterThanOrEqual(90 * 60_000);
    const names = h.scheduler.list().map((x) => x.name);
    expect(names).toEqual(expect.arrayContaining([ScheduleNames.warn15(sid, 1), ScheduleNames.warn5(sid, 1), ScheduleNames.expire(sid, 1), ScheduleNames.readyIdle(sid)]));
    expect(h.dev.lifecycle.workstationTag).toBe(sid);
    expect(await h.item(Keys.activeEnvironmentLock())).toMatchObject({ holderSessionId: sid, holderEnvId: s.envId });
    expect(h.runner.ops().map((o) => o.split(':')[0])).toEqual(['base-deploy', 'workstation-up', 'profile-apply']);
    expect(s.phases?.map((p) => `${p.name}:${p.status}`)).toEqual(expect.arrayContaining(['start.validate:DONE', 'provision.base:RUNNING', 'provision.ready:DONE']));

    const hb = await h.lifecycle<{ state: string }>({ action: 'Heartbeat', sessionId: sid, workbench: true });
    expect(hb.state).toBe('RUNNING');

    await h.lifecycle({ action: 'RequestEnd', sessionId: sid, disposition: 'destroy', when: 'now', actor: 'user' });
    const end = await h.waitExecution('atl-session-end', ExecutionNames.endFirst(sid));
    expect(end.status).toBe('SUCCEEDED');
    s = await h.session(sid);
    expect(s.state).toBe('ENDED');
    expect(s.endReason).toBe('USER_ENDED');
    expect(s.revokedAt).toBeTruthy();
    expect(s.reclaim?.followUp).toBe('PENDING');
    expect(s.reclaim?.rescanAt).toHaveLength(3);
    expect(h.dev.lifecycle.revocations.revoked[sid]).toBeTruthy();
    expect(h.dev.lifecycle.revocations.finalizing).toBeNull();
    expect(h.dev.lifecycle.workstationTag).toBeNull();
    expect(await h.item(Keys.activeEnvironmentLock())).toMatchObject({ holderSessionId: null });
    // stacks and out-of-band resources are gone
    expect([...h.dev.reclaim.resources.keys()]).toEqual([]);
    expect(h.checks.calls.map((c) => c.action)).toEqual(['Preflight', 'RunHealthGate', 'FinalizeAttempt']);
    expect(h.dev.reclaim.appRoleResets).toEqual([{ full: true, policyArns: expect.arrayContaining([expect.stringContaining(':policy/cloudalbum-')]) }]);
    expect(h.dev.reclaim.deleteCalls.every((c) => c.roleSessionName.startsWith(`atl-${sid}-reap-`))).toBe(true);

    // rescans at revokedAt + 20 min, + 60 min, + 6 h; then followUp = DONE
    const rescan = await h.waitExecution('atl-reclaim-rescan', ExecutionNames.rescan(s.envId!));
    expect(rescan.status).toBe('SUCCEEDED');
    s = await h.session(sid);
    expect(s.reclaim?.followUp).toBe('DONE');
    expect(s.state).toBe('ENDED');
    const env = await h.item(Keys.environment(s.envId!));
    expect(env).toMatchObject({ status: 'RELEASED' });
    expect(env?.GSI2PK).toBeUndefined();
  }, 60_000);
});
