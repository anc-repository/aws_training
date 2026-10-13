/**
 * `kind=SWEEP` (02 §5.7, schedule `atl-sweeper`, every 5 minutes while there is something to sweep): the third safety
 * net. Expired-but-not-ending sessions, kept environments past keep.until, state timeouts, schedule reconciliation,
 * lock consistency, the timer DLQ, light environment health, expected-outage windows, CLEANUP_FAILED auto-retries,
 * revocation entry clean-up and the rescan backstop. It disables itself when nothing is left.
 */
import { ceilToMinute, ExecutionNames, isPortError, isTerminal, type TimerPayload } from '@atl/shared';
import type { Ctx } from '../lifecycle/context.js';
import { MINUTE } from '../lifecycle/context.js';
import type { SessionRecord } from '../lifecycle/store/model.js';
import { getEnvironment } from '../lifecycle/store/environments.js';
import { getConfig, getLock, liveReservation } from '../lifecycle/store/platform.js';
import { sessionsInState, sweepSessions } from '../lifecycle/store/records.js';
import { AUTO_RETRY_AFTER_MINUTES, cleanupBudgetMinutes, provisioningTimeoutMinutes } from '../lifecycle/rules.js';
import { deadlineSchedules, idleSchedule, keepSchedules } from '../lifecycle/timers.js';
import { handleTimer, lifecycle, startEnd } from './kinds.js';

const GRACE_MS = 2 * MINUTE;

export interface SweepReport {
  at: string;
  sessions: number;
  actions: { sid?: string; action: string; detail?: string }[];
  disabled: boolean;
}

async function execStatus(ctx: Ctx, stateMachine: 'atl-session-start' | 'atl-session-end' | 'atl-reclaim' | 'atl-reclaim-rescan', name: string): Promise<string | null> {
  try {
    return (await ctx.ports.orchestrator.describeExecution(ctx.ports.orchestrator.executionArn(stateMachine, name))).status;
  } catch (e) {
    if (isPortError(e, 'ExecutionDoesNotExist') || isPortError(e, 'NotFound')) return null;
    throw e;
  }
}

function endExecName(s: SessionRecord): string {
  if (s.endPhase === 'release') return ExecutionNames.endRelease(s.sid);
  if (s.endPhase === 'retry') return ExecutionNames.endRetry(s.sid, s.cleanupRetryCount ?? 1);
  return ExecutionNames.endFirst(s.sid);
}

export async function sweep(ctx: Ctx): Promise<SweepReport> {
  const report: SweepReport = { at: ctx.nowIso(), sessions: 0, actions: [], disabled: false };
  const note = (action: string, sid?: string, detail?: string) => report.actions.push({ ...(sid ? { sid } : {}), action, ...(detail ? { detail } : {}) });
  const now = ctx.nowMs();
  const cfg = await getConfig(ctx);

  // dead letters first: they are timer events that never arrived (02 §5.2)
  try {
    for (const payload of await ctx.clouds().lifecycle.drainTimerDlq(20)) {
      if (payload.kind === 'SWEEP') continue;
      await handleTimer(ctx, payload as Exclude<TimerPayload, { kind: 'SWEEP' }>).catch(() => undefined);
      note('dlq-replayed', 'sessionId' in payload ? payload.sessionId : undefined, payload.kind);
    }
  } catch (e) {
    note('dlq-error', undefined, e instanceof Error ? e.message : String(e));
  }

  const sessions = await sweepSessions(ctx);
  report.sessions = sessions.length;
  let work = false;
  for (const s of sessions) {
    try {
      work = (await sweepOne(ctx, s, now, note)) || work;
    } catch (e) {
      note('error', s.sid, e instanceof Error ? e.message : String(e));
      work = true;
    }
  }

  // lock consistency (holder terminal and not KEPT; stale reservation)
  const lock = await getLock(ctx);
  if (lock.holderSessionId && !sessions.some((x) => x.sid === lock.holderSessionId && !isTerminal(x.state) && x.state !== 'CLEANUP_FAILED')) {
    const r = await lifecycle<{ repaired: boolean }>(ctx, { action: 'RepairLock' });
    if (r.repaired) note('lock-repaired', lock.holderSessionId);
  } else if (lock.pendingSessionId && !liveReservation(lock, now)) {
    await lifecycle(ctx, { action: 'RepairLock' });
    note('reservation-cleared', lock.pendingSessionId);
  }

  // revocation entries past the last credential expiry + 15 min (02 §6.3)
  const pruned = await lifecycle<{ removed: string[]; remaining: number }>(ctx, { action: 'PruneRevocations' }).catch(() => ({ removed: [], remaining: 0 }));
  if (pruned.removed.length) note('revocations-pruned', undefined, pruned.removed.join(','));
  if (pruned.remaining > 0) work = true;

  // nothing left to sweep → disable (re-check new sessions first: T01 enables it again unconditionally)
  if (!work && cfg.mode !== 'UNINSTALLING') {
    const fresh = await sessionsInState(ctx, 'REQUESTED');
    if (fresh.length === 0) {
      await ctx.ports.scheduler.setSweeperEnabled(false);
      report.disabled = true;
    }
  }
  return report;
}

type Note = (action: string, sid?: string, detail?: string) => void;

/** Returns true when the session still needs sweeping. */
async function sweepOne(ctx: Ctx, s: SessionRecord, now: number, note: Note): Promise<boolean> {
  const entered = Date.parse(s.stateEnteredAt);
  switch (s.state) {
    case 'REQUESTED': {
      if (now > entered + 5 * MINUTE) {
        const st = await execStatus(ctx, 'atl-session-start', ExecutionNames.start(s.sid));
        if (st === 'RUNNING') await ctx.ports.orchestrator.stopExecution(ctx.ports.orchestrator.executionArn('atl-session-start', ExecutionNames.start(s.sid)), { error: 'Atl.StartTimeout', cause: 'START_TIMEOUT' });
        await lifecycle(ctx, { action: 'FailBeforeProvision', sessionId: s.sid, error: { Error: 'States.Timeout', Cause: 'START_TIMEOUT' } });
        note('start-timeout', s.sid);
      }
      return true;
    }
    case 'PROVISIONING': {
      const started = Date.parse(s.provisioningStartedAt ?? s.stateEnteredAt);
      if (now > started + provisioningTimeoutMinutes(s.cardSnapshot) * MINUTE) {
        const st = await execStatus(ctx, 'atl-session-start', ExecutionNames.start(s.sid));
        if (st === 'RUNNING') await ctx.ports.orchestrator.stopExecution(ctx.ports.orchestrator.executionArn('atl-session-start', ExecutionNames.start(s.sid)), { error: 'Atl.ProvisionTimeout', cause: 'PROVISION_TIMEOUT' });
        const r = await startEnd(ctx, ExecutionNames.endFirst(s.sid), { sessionId: s.sid, reason: 'PROVISION_TIMEOUT', disposition: 'destroy', failure: { Error: 'States.Timeout', Cause: 'PROVISION_TIMEOUT' }, actor: 'sweeper' });
        note('provision-timeout', s.sid, r);
      }
      return true;
    }
    case 'READY':
    case 'RUNNING':
    case 'EXPIRING': {
      const deadline = s.deadlineAt ? Date.parse(s.deadlineAt) : NaN;
      if (s.budgetEnforceAt && now >= Date.parse(String(s.budgetEnforceAt))) {
        note('budget-enforced', s.sid, await startEnd(ctx, ExecutionNames.endFirst(s.sid), { sessionId: s.sid, reason: 'BUDGET_ENFORCED', disposition: 'destroy', actor: 'sweeper' }));
        return true;
      }
      if (now > deadline + GRACE_MS) {
        note('expired-late', s.sid, await startEnd(ctx, ExecutionNames.endFirst(s.sid), { sessionId: s.sid, reason: 'EXPIRED', disposition: s.preferredDisposition?.disposition ?? 'destroy', actor: 'sweeper' }));
        return true;
      }
      if (s.state === 'READY' || s.state === 'RUNNING') {
        if (deadline - now <= 15 * MINUTE) {
          await lifecycle(ctx, { action: 'Transition', sessionId: s.sid, from: ['READY', 'RUNNING'], to: 'EXPIRING', reason: 'REMAINING_LE_15', deadlineVersion: s.deadlineVersion ?? 1 }).catch(() => undefined);
        }
      }
      await reconcileSchedules(ctx, s, note);
      if (s.outageWindow && Date.parse(s.outageWindow.until) <= now) {
        await lifecycle(ctx, { action: 'CloseOutageWindow', sessionId: s.sid, expiredOnly: true });
        note('outage-window-closed', s.sid);
      }
      if (s.state === 'RUNNING') await healthCheck(ctx, s, note);
      return true;
    }
    case 'ENDING': {
      if (now > entered + 20 * MINUTE && (await execStatus(ctx, 'atl-session-end', endExecName(s))) !== 'RUNNING') {
        await lifecycle(ctx, { action: 'EmergencyConclude', sessionId: s.sid, error: { Error: 'States.Timeout', Cause: 'ENDING timed out without a running end workflow' } });
        note('ending-timeout', s.sid);
      }
      return true;
    }
    case 'KEPT': {
      if (s.keep && now > Date.parse(s.keep.until) + GRACE_MS) {
        const lock = await getLock(ctx);
        const pending = liveReservation(lock, now);
        if (!pending || pending === s.sid) {
          note('keep-expired-late', s.sid, await startEnd(ctx, ExecutionNames.endRelease(s.sid), { sessionId: s.sid, reason: 'KEEP_EXPIRED', disposition: 'destroy', actor: 'sweeper' }));
        }
      } else {
        await reconcileSchedules(ctx, s, note);
      }
      return true;
    }
    case 'CLEANING': {
      const budgetMs = cleanupBudgetMinutes(s.cardSnapshot) * MINUTE;
      if (now > entered + budgetMs) {
        if (await pendingWithinDeadline(ctx, s, now)) return true; // async deletions within their own deadline extend the timeout (02 §2.1)
        const name = endExecName(s);
        if ((await execStatus(ctx, 'atl-session-end', name)) === 'RUNNING') {
          await ctx.ports.orchestrator.stopExecution(ctx.ports.orchestrator.executionArn('atl-session-end', name), { error: 'Atl.CleanupTimeout', cause: 'CLEANUP_TIMEOUT' });
        }
        await lifecycle(ctx, { action: 'EmergencyConclude', sessionId: s.sid, error: { Error: 'Atl.CleanupTimeout', Cause: 'CLEANUP_TIMEOUT' } });
        note('cleanup-timeout', s.sid);
      }
      return true;
    }
    case 'CLEANUP_FAILED': {
      const retries = s.autoCleanupRetries ?? 0;
      let work = await rescanBackstop(ctx, s, now, note);
      if (retries < AUTO_RETRY_AFTER_MINUTES.length) {
        work = true;
        if (now >= entered + AUTO_RETRY_AFTER_MINUTES[retries]! * MINUTE) {
          await lifecycle(ctx, { action: 'RetryCleanup', sessionId: s.sid, auto: true, actor: 'sweeper', expectedRetryCount: s.cleanupRetryCount ?? 0 });
          note('cleanup-auto-retry', s.sid, String(retries + 1));
        }
      }
      return work;
    }
    case 'ENDED':
    case 'FAILED':
      return rescanBackstop(ctx, s, now, note);
  }
  return false;
}

/** Re-create missing schedules of the current deadline / keep version whose time is still ahead (02 §5.7). */
async function reconcileSchedules(ctx: Ctx, s: SessionRecord, note: Note): Promise<void> {
  const now = ctx.nowMs();
  const planned =
    s.state === 'KEPT' && s.keep
      ? keepSchedules(s.sid, Date.parse(s.keep.until), s.keep.version)
      : s.deadlineAt
        ? [
            ...deadlineSchedules(s.sid, Date.parse(s.deadlineAt), s.deadlineVersion ?? 1),
            ...(s.state === 'READY' && s.readyAt ? [idleSchedule(s.sid, Date.parse(s.readyAt), (await getConfig(ctx)).limits.readyIdleMinutes, s.deadlineVersion ?? 1)] : []),
          ]
        : [];
  for (const p of planned) {
    const at = ceilToMinute(p.at);
    if (at <= now + MINUTE) continue; // fires now anyway (or already did)
    if (await ctx.ports.scheduler.get(p.name, 'atl-sessions')) continue;
    await ctx.ports.scheduler.createOneTime({ name: p.name, group: 'atl-sessions', at: new Date(at), payload: p.payload });
    note('schedule-recreated', s.sid, p.name);
  }
}

async function pendingWithinDeadline(ctx: Ctx, s: SessionRecord, now: number): Promise<boolean> {
  if (!s.envId) return false;
  const items = await ctx.main.query<{ cleanupState?: string; deadlineAt?: string | null }>({
    pk: { attr: 'PK', value: `ENV#${s.envId}` },
    sk: { attr: 'SK', beginsWith: 'RES#' },
  });
  return items.some((i) => i.cleanupState === 'DELETING' && i.deadlineAt && Date.parse(i.deadlineAt) > now);
}

/** Light health of a RUNNING session (02 §5.7 “体检判定”), honouring the expected-outage window (5.8). */
async function healthCheck(ctx: Ctx, s: SessionRecord, note: Note): Promise<void> {
  if (!s.envId) return;
  const env = await getEnvironment(ctx, s.envId);
  if (!env) return;
  const cloud = ctx.clouds().lifecycle;
  const found = await cloud.discoverInstances({ envId: env.envId, envName: env.envName, sessionIds: env.sessionChain });
  const inWindow = !!s.outageWindow && Date.parse(s.outageWindow.until) > ctx.nowMs();
  const lab = found.filter((i) => i.role === 'lab-app');
  const wsStack = s.workstation?.stackName ?? null;
  const ws = found.filter((i) => i.role === 'workstation' && (!wsStack || i.stackName === wsStack));
  const problems: string[] = [];
  const live = lab.filter((i) => !['terminated', 'shutting-down'].includes(i.state));
  if (live.length === 0) problems.push('lab instance terminated or missing');
  if (s.workstation?.mode === 'ec2' && ws.filter((i) => !['terminated', 'shutting-down'].includes(i.state)).length === 0) problems.push('workstation terminated or missing');
  if (!inWindow) {
    if (live.length > 0 && live.every((i) => i.state === 'stopped' || i.state === 'stopping')) problems.push('lab instance stopped');
    const running = [...live, ...ws].filter((i) => i.state === 'running').map((i) => i.instanceId);
    if (running.length) {
      const ping = await cloud.ssmPing(running);
      if (running.some((id) => ping[id] !== 'Online')) problems.push('management channel unreachable');
    }
  }
  const status = problems.length ? 'degraded' : 'ok';
  const r = await lifecycle<{ changed: boolean }>(ctx, { action: 'RecordEnvHealth', sessionId: s.sid, status, detail: problems.join('; ') || null });
  if (r.changed) note(`env-${status}`, s.sid, problems.join('; '));
}

/** Rescan backstop (02 §7.7 point 6): in the rescan window without a running `rescan-<envId>`. Returns true while the window is open. */
async function rescanBackstop(ctx: Ctx, s: SessionRecord, now: number, note: Note): Promise<boolean> {
  if (!s.envId || s.reclaim?.followUp !== 'PENDING') return false;
  const st = await execStatus(ctx, 'atl-reclaim-rescan', ExecutionNames.rescan(s.envId));
  if (st === 'RUNNING') return true;
  if (st === 'SUCCEEDED') {
    await lifecycle(ctx, { action: 'FinishFollowUp', sessionId: s.sid, envId: s.envId }); // finished but the window was not closed
    note('followup-closed', s.sid);
    return false;
  }
  const k = s.reclaim.sweeperRescans ?? 0;
  if (k === 0) {
    await ctx.clouds().lifecycle.notify('atl-alerts', `ATL: rescans of ${s.envId} are not running`, `The rescan workflow of session ${s.sid} is ${st ?? 'missing'}; the sweeper runs one RESCAN pass.`).catch(() => undefined);
    const { k: next } = await lifecycle<{ k: number }>(ctx, { action: 'NoteSweeperRescan', sessionId: s.sid });
    await ctx.ports.orchestrator
      .startExecution({ stateMachine: 'atl-reclaim', name: ExecutionNames.reclaim(s.envId, 'RESCAN', 10 + next), input: { envId: s.envId, sessionId: s.sid, mode: 'RESCAN' } })
      .catch((e: unknown) => {
        if (!isPortError(e, 'ExecutionAlreadyExists')) throw e;
      });
    note('rescan-redone', s.sid);
    return true;
  }
  const name = ExecutionNames.reclaim(s.envId, 'RESCAN', 10 + k);
  const passStatus = await execStatus(ctx, 'atl-reclaim', name);
  if (passStatus === 'RUNNING') return true;
  const d = await ctx.ports.orchestrator.describeExecution(ctx.ports.orchestrator.executionArn('atl-reclaim', name)).catch(() => null);
  const summary = (d?.output as { summary?: unknown } | undefined)?.summary;
  // the sweeper's single pass replaces the remaining rescan time points: conclude it and close the window
  await lifecycle(ctx, { action: 'ConcludeRescan', sessionId: s.sid, envId: s.envId, index: 10 + k, result: summary ? { summary } : { Error: d?.error ?? 'FAILED' } });
  await lifecycle(ctx, { action: 'FinishFollowUp', sessionId: s.sid, envId: s.envId });
  note('followup-closed', s.sid, `after sweeper pass at ${new Date(now).toISOString()}`);
  return false;
}
