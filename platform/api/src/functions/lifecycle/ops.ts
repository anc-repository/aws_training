/**
 * Background actions of atl-lifecycle: BudgetAlert (SNS `atl-budget`, 02 §10.4), HandleExecutionFailure (EventBridge
 * rule `atl-sfn-failed`, the second safety net of 02 §2.6), PruneRevocations (revocation entries past the last
 * credential expiry + 15 min, 02 §6.3), BudgetEnforce (end-active: end after a 10-minute warning).
 */
import { ExecutionNames, isPortError, type BudgetState } from '@atl/shared';
import type { Ctx } from './context.js';
import { MINUTE } from './context.js';
import { emergencyConclude } from './end.js';
import { failBeforeProvision } from './start.js';
import { finishModuleOp } from './module-op.js';
import { lastCredentialExpiry, listGrants, sessionsInState } from './store/records.js';
import { getConfig, getLock, liveReservation, lockWrite, updateConfig } from './store/platform.js';
import { getSession, mutateSession } from './store/sessions.js';
import { emit } from './store/events.js';

// ---------------------------------------------------------------------------------------------------------------
// BudgetAlert

/** State from an AWS Budgets notification text (actual ≥ 100 % → EXCEEDED, otherwise WARN). */
export function budgetStateFromMessage(msg: string): BudgetState {
  const pct = /(\d+(?:\.\d+)?)\s*%/.exec(msg);
  const actual = /ACTUAL/i.test(msg);
  if (pct && actual && Number(pct[1]) >= 100) return 'EXCEEDED';
  return 'WARN';
}

export async function budgetAlert(ctx: Ctx, p: { state?: BudgetState; message?: string }) {
  const state: BudgetState = p.state ?? budgetStateFromMessage(p.message ?? '');
  const cfg = await getConfig(ctx);
  if (cfg.budget.state !== state) {
    await updateConfig(ctx, { budget: { ...(cfg.raw.budget as Record<string, unknown> | undefined), state, stateAt: ctx.nowIso() } });
    await ctx.ports.events.publish([{ source: 'atl.lifecycle', detailType: 'budget.state_changed', detail: { state, at: ctx.nowIso() } }]).catch(() => undefined);
  }
  let warned = 0;
  if (state === 'EXCEEDED' && cfg.budget.enforcement === 'end-active') {
    // 10-minute warning, then BUDGET_ENFORCED (the sweeper ends sessions whose budgetEnforceAt passed)
    for (const st of ['READY', 'RUNNING', 'EXPIRING'] as const) {
      for (const s of await sessionsInState(ctx, st)) {
        const at = new Date(ctx.nowMs() + 10 * MINUTE).toISOString();
        await mutateSession(ctx, s.sid, (cur) => (cur.budgetEnforceAt ? null : { patch: { budgetEnforceAt: at } }));
        await emit(ctx, s.sid, [{ type: 'session.expiry_warning', data: { minutesLeft: 10, deadlineVersion: s.deadlineVersion ?? 1, reason: 'budget' } }]);
        warned++;
      }
    }
  }
  return { state, warned };
}

// ---------------------------------------------------------------------------------------------------------------
// HandleExecutionFailure (EventBridge `Step Functions Execution Status Change`, FAILED / TIMED_OUT / ABORTED)

export interface SfnStatusEvent {
  executionArn?: string;
  stateMachineArn?: string;
  name?: string;
  status?: string;
  error?: string | null;
  cause?: string | null;
}

export async function handleExecutionFailure(ctx: Ctx, d: SfnStatusEvent) {
  const name = d.name ?? (d.executionArn ? d.executionArn.slice(d.executionArn.lastIndexOf(':') + 1) : '');
  const status = d.status ?? 'FAILED';
  if (!['FAILED', 'TIMED_OUT', 'ABORTED'].includes(status)) return { handled: false };
  let m = /^start-(s[0-9a-z]{12})$/.exec(name);
  if (m) {
    const s = await getSession(ctx, m[1]!);
    if (!s) return { handled: false };
    if (s.startExecutionArn && d.executionArn && s.startExecutionArn !== d.executionArn) return { handled: false, reason: 'stale event' };
    if (s.state === 'REQUESTED') {
      await failBeforeProvision(ctx, { sessionId: s.sid, error: { Error: status === 'TIMED_OUT' ? 'States.Timeout' : (d.error ?? 'States.Runtime'), Cause: status === 'TIMED_OUT' ? 'START_TIMEOUT' : 'WORKFLOW_ERROR' } });
      return { handled: true, action: 'T03' };
    }
    if (s.state === 'PROVISIONING') {
      const reason = status === 'TIMED_OUT' ? 'PROVISION_TIMEOUT' : 'PROVISION_FAILED';
      try {
        await ctx.ports.orchestrator.startExecution({
          stateMachine: 'atl-session-end',
          name: ExecutionNames.endFirst(s.sid),
          input: { sessionId: s.sid, reason, disposition: 'destroy', failure: { Error: d.error ?? `States.${status}`, Cause: d.cause ?? reason }, actor: 'system' },
        });
      } catch (e) {
        if (!isPortError(e, 'ExecutionAlreadyExists')) throw e;
      }
      return { handled: true, action: 'compensate' };
    }
    return { handled: false };
  }
  m = /^end-(s[0-9a-z]{12})-(1|rel|retry-\d+)$/.exec(name);
  if (m) {
    const s = await getSession(ctx, m[1]!);
    if (!s || ['ENDED', 'FAILED', 'CLEANUP_FAILED', 'KEPT'].includes(s.state)) {
      if (s?.state === 'KEPT') await alert(ctx, `end workflow ${name} ${status} while the environment is kept`);
      return { handled: false };
    }
    // only the end phase that currently owns the session counts (a late event of an older phase must not touch a retry)
    const current =
      s.endPhase === 'release' ? ExecutionNames.endRelease(s.sid) : s.endPhase === 'retry' ? ExecutionNames.endRetry(s.sid, s.cleanupRetryCount ?? 1) : ExecutionNames.endFirst(s.sid);
    if (current !== name) return { handled: false, reason: `stale event: ${name} is not the current end phase (${current})` };
    await emergencyConclude(ctx, { sessionId: s.sid, error: { Error: d.error ?? `States.${status}`, Cause: d.cause ?? 'WORKFLOW_ERROR' } });
    return { handled: true, action: 'emergency' };
  }
  m = /^modop-(s[0-9a-z]{12})-\d+$/.exec(name);
  if (m) {
    await finishModuleOp(ctx, { sessionId: m[1]!, opId: null, runId: null, executionName: name, status: 'FAILED', error: { Error: d.error ?? status } }).catch(() => undefined);
    return { handled: true, action: 'modop' };
  }
  await alert(ctx, `${name} ${status}: ${d.error ?? ''} ${d.cause ?? ''}`.trim());
  return { handled: true, action: 'alert' };
}

async function alert(ctx: Ctx, message: string): Promise<void> {
  await ctx.clouds().lifecycle.notify('atl-alerts', 'ATL: workflow problem', message).catch(() => undefined);
}

// ---------------------------------------------------------------------------------------------------------------
// PruneRevocations (02 §6.3 “条目清理与大小”)

export async function pruneRevocations(ctx: Ctx) {
  const cloud = ctx.clouds().lifecycle;
  const state = await cloud.getRevocations();
  const removed: string[] = [];
  for (const sid of Object.keys(state.revoked)) {
    const s = await getSession(ctx, sid);
    const grants = await listGrants(ctx, sid);
    const last = lastCredentialExpiry(grants, s?.revokedAt ?? state.revoked[sid] ?? null);
    if (ctx.nowMs() > last + 15 * MINUTE) {
      delete state.revoked[sid];
      removed.push(sid);
    }
  }
  if (removed.length) await cloud.putRevocations(state);
  return { removed, remaining: Object.keys(state.revoked).length + (state.finalizing ? 1 : 0) };
}

// ---------------------------------------------------------------------------------------------------------------
// Sweeper helpers (atl-timer SWEEP reads; the writes stay here)

/** Light environment health of a RUNNING session (02 §5.7): env.degraded / env.recovered on a change only. */
export async function recordEnvHealth(ctx: Ctx, p: { sessionId: string; status: 'ok' | 'degraded'; detail: string | null }) {
  let changed = false;
  await mutateSession(ctx, p.sessionId, (s) => {
    const prev = s.envHealth?.status ?? 'ok';
    if (prev === p.status && (s.envHealth?.detail ?? null) === p.detail) return null;
    changed = prev !== p.status || p.status === 'degraded';
    return {
      patch: { envHealth: { status: p.status, detail: p.detail, at: ctx.nowIso() } },
      events: changed ? [{ type: p.status === 'ok' ? 'env.recovered' : 'env.degraded', data: { detail: p.detail } }] : [],
    };
  });
  return { changed };
}

/** The sweeper redoes a rescan pass (02 §7.7 point 6): counter of its passes (name reclaim-<envId>-rescan-<10+k>). */
export async function noteSweeperRescan(ctx: Ctx, p: { sessionId: string }) {
  let k = 0;
  await mutateSession(ctx, p.sessionId, (s) => {
    if (!s.reclaim) return null;
    k = (s.reclaim.sweeperRescans ?? 0) + 1;
    return { patch: { reclaim: { ...s.reclaim, sweeperRescans: k } } };
  });
  return { k };
}

/** Lock consistency (02 §5.7): a holder that is terminal (and not KEPT) releases the lock; reservations past pendingUntil are cleared. */
export async function repairLock(ctx: Ctx) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const lock = await getLock(ctx);
    const patch: Record<string, unknown> = {};
    if (lock.holderSessionId) {
      const h = await getSession(ctx, lock.holderSessionId);
      if (!h || ['ENDED', 'FAILED', 'CLEANUP_FAILED'].includes(h.state)) Object.assign(patch, { holderEnvId: null, holderSessionId: null, acquiredAt: null });
    }
    if (lock.pendingSessionId && !liveReservation(lock, ctx.nowMs())) Object.assign(patch, { pendingSessionId: null, pendingUntil: null });
    if (Object.keys(patch).length === 0) return { repaired: false };
    try {
      await ctx.main.transact([lockWrite(ctx, lock, patch)]);
      await alert(ctx, `ActiveEnvironmentLock repaired: ${JSON.stringify(patch)}`);
      return { repaired: true, patch };
    } catch {
      continue;
    }
  }
  return { repaired: false };
}
