/**
 * atl-lifecycle actions of the end workflow (02 §6): BeginEnd, StopActiveBuilds, DisarmTimers, CloseLearnerAccess,
 * SealRevocation, EnterKept, EnterCleaning (the `Transition` to CLEANING), Conclude, EmergencyConclude.
 */
import {
  ExecutionNames,
  Keys,
  RoleSessionNames,
  isTerminal,
  type Disposition,
  type EndReason,
  type ReclaimPassMode,
} from '@atl/shared';
import { resourceKey } from '@atl/shared/node';
import type { Ctx } from './context.js';
import { MINUTE } from './context.js';
import { err, WorkflowError } from './errors.js';
import { buildFailure, type SfnError } from './failures.js';
import { failBeforeProvision } from './start.js';
import { phasePatch, type Mark } from './phases.js';
import { concludeState, envBudget, keepHoursLimit, rescanTimes, type ReclaimSummary } from './rules.js';
import { uploadExemptResource } from './cloud/revocation-policy.js';
import { allScheduleNames, createSchedules, deleteSchedules, keepSchedules } from './timers.js';
import { environmentUpdate, getEnvironment, mutateEnvironment } from './store/environments.js';
import type { SessionRecord } from './store/model.js';
import { getConfig, getLock, liveReservation, lockReleaseIfHolder, lockWrite } from './store/platform.js';
import { revokeGrants } from './store/records.js';
import { mustGetSession, mutateSession, transitionSession } from './store/sessions.js';
import type { TransactItem } from './store/ddb.js';

// ---------------------------------------------------------------------------------------------------------------
// BeginEnd

export interface EndInput {
  sessionId: string;
  reason: EndReason;
  disposition?: Disposition;
  failure?: SfnError | null;
  actor?: string;
  /** atl-api's form (POST /end with disposition keep, already validated against the KEEP quote and the limits) */
  keep?: { hours?: number; quoteId?: string | null; saveMode?: boolean; confirmedAt?: string } | null;
  keepPrerequisites?: string[];
}

export interface EndContext {
  sessionId: string;
  envId: string | null;
  envName: string | null;
  labId: string;
  reason: EndReason;
  disposition: Disposition;
  endPhase: 'first' | 'release' | 'retry';
  endSeq: number;
  startExecutionRunning: boolean;
  startExecutionArn: string | null;
  skipToCleaning: boolean;
  needFinalize: boolean;
  skipWorkstationDown: boolean;
  hasEnvironment: boolean;
  keep: { saveMode: boolean; hours: number | null };
  budget: { destroyBuildMinutes: number; destroyTaskSeconds: number };
  reclaimMode: ReclaimPassMode;
  reclaimName: string | null;
}

/** end-<sid>-1 → first, end-<sid>-rel → release, end-<sid>-retry-<k> → retry k (02 §2.7, §6.1). */
export function endPhaseOf(executionName: string | undefined, sid: string): { phase: 'first' | 'release' | 'retry'; seq: number; k: number } {
  if (executionName === ExecutionNames.endRelease(sid)) return { phase: 'release', seq: 2, k: 0 };
  const m = /^end-s[0-9a-z]{12}-retry-(\d+)$/.exec(executionName ?? '');
  if (m) return { phase: 'retry', seq: 2 + Number(m[1]), k: Number(m[1]) };
  return { phase: 'first', seq: 1, k: 0 };
}

const NO_KEEP_REASONS: EndReason[] = ['IDLE_NOT_STARTED', 'BUDGET_ENFORCED', 'ADMIN_ENDED', 'PLATFORM_UNINSTALL', 'CANCELLED', 'PROVISION_FAILED', 'PROVISION_TIMEOUT'];

/**
 * The keep request of this end: the lifecycle's own (RequestEnd), else atl-api's — `input.keep` of POST /end, or for an
 * expiry the `preferredDisposition` the API stored (object form with keepHours / quoteId / saveMode / confirmedAt).
 */
export function keepRequestOf(s: SessionRecord, input: EndInput, nowIso: string): SessionRecord['keepRequest'] {
  if (s.keepRequest) return s.keepRequest;
  const pref = s.preferredDisposition as (SessionRecord['preferredDisposition'] & { saveMode?: boolean | null; confirmedAt?: string | null }) | null | undefined;
  const k =
    input.reason === 'EXPIRED'
      ? pref?.disposition === 'keep'
        ? { hours: pref.keepHours ?? undefined, quoteId: pref.quoteId, saveMode: pref.saveMode ?? undefined, confirmedAt: pref.confirmedAt ?? undefined }
        : null
      : input.disposition === 'keep'
        ? (input.keep ?? null)
        : null;
  const hours = Number(k?.hours);
  if (!k || !Number.isFinite(hours) || hours <= 0) return null;
  return { hours, quoteId: k.quoteId ?? null, saveMode: k.saveMode !== false, confirmedAt: k.confirmedAt ?? nowIso };
}

function decideDisposition(s: SessionRecord, input: EndInput, keepRequest: SessionRecord['keepRequest']): Disposition {
  if (NO_KEEP_REASONS.includes(input.reason)) return 'destroy';
  if (!s.cardSnapshot.retain.allowed) return 'destroy';
  if (input.reason === 'EXPIRED') return s.preferredDisposition?.disposition === 'keep' && keepRequest ? 'keep' : 'destroy';
  return input.disposition === 'keep' && keepRequest ? 'keep' : 'destroy';
}

async function isRunning(ctx: Ctx, arn: string | null | undefined): Promise<boolean> {
  if (!arn) return false;
  try {
    return (await ctx.ports.orchestrator.describeExecution(arn)).status === 'RUNNING';
  } catch {
    return false;
  }
}

export async function beginEnd(ctx: Ctx, p: { input: EndInput; executionId?: string; executionName?: string }): Promise<EndContext> {
  const input = p.input;
  const sid = input.sessionId;
  const s0 = await mustGetSession(ctx, sid);
  const ph = endPhaseOf(p.executionName, sid);
  const startArn = s0.startExecutionArn ?? ctx.ports.orchestrator.executionArn('atl-session-start', ExecutionNames.start(sid));

  if (isTerminal(s0.state)) throw err.alreadyTerminal(`session ${sid} is already ${s0.state}`);
  // another end phase owns the session already (e.g. two retries started concurrently): this execution steps aside
  if ((s0.state === 'CLEANING' || s0.state === 'ENDING') && s0.endSeq !== undefined && s0.endSeq !== ph.seq) {
    throw new WorkflowError('Atl.Superseded', `session ${sid} is ${s0.state} under end phase ${s0.endSeq}, not ${ph.seq}`);
  }

  if (s0.state === 'REQUESTED') {
    // no environment yet: stop the start workflow and end the request (T04 path for uninstall / admin)
    if (await isRunning(ctx, startArn)) await ctx.ports.orchestrator.stopExecution(startArn, { error: 'Atl.Superseded', cause: input.reason }).catch(() => undefined);
    await cancelRequested(ctx, sid, input.reason === 'CANCELLED' ? 'CANCELLED' : input.reason);
    throw err.alreadyTerminal(`session ${sid} ended before PROVISIONING`);
  }

  const cfg = await getConfig(ctx);
  let reason = input.reason;
  let disposition: Disposition = 'destroy';
  const marks: Mark[] = [];

  if (s0.state === 'PROVISIONING') {
    reason = (['PROVISION_FAILED', 'PROVISION_TIMEOUT', 'CANCELLED', 'PLATFORM_UNINSTALL', 'ADMIN_ENDED', 'BUDGET_ENFORCED'] as EndReason[]).includes(input.reason)
      ? input.reason
      : 'PROVISION_FAILED';
    await transitionSession(ctx, sid, {
      from: ['PROVISIONING'],
      to: 'CLEANING',
      reason,
      patch: (s) => ({
        endReason: reason,
        disposition: 'destroy',
        endSeq: ph.seq,
        endPhase: ph.phase,
        endExecutionArns: [...(s.endExecutionArns ?? []), ...(p.executionId ? [p.executionId] : [])],
        ...(reason === 'PROVISION_FAILED' || reason === 'PROVISION_TIMEOUT' ? { failure: s.failure ?? buildFailure(s, input.failure ?? null, reason === 'PROVISION_TIMEOUT' ? 'PROVISION_TIMEOUT' : 'WORKFLOW_ERROR') } : {}),
        ...phasePatch(ctx, s, [{ phase: currentRunning(s), status: 'FAILED' }, { phase: 'clean.destroy', status: 'QUEUED' }]).patch,
      }),
      events: (s) => [
        { type: 'session.end_requested', data: { by: input.actor ?? 'system', reason: endRequestedReason(reason) } },
        ...phasePatch(ctx, s, [{ phase: currentRunning(s), status: 'FAILED' }, { phase: 'clean.destroy', status: 'QUEUED' }]).events,
      ],
    });
  } else if (s0.state === 'READY' || s0.state === 'RUNNING' || s0.state === 'EXPIRING') {
    const keepRequest = keepRequestOf(s0, input, ctx.nowIso());
    disposition = decideDisposition(s0, input, keepRequest);
    if (disposition === 'keep' && (cfg.mode === 'UNINSTALLING' || (cfg.budget.state === 'EXCEEDED' && cfg.budget.enforcement !== 'notify'))) disposition = 'destroy';
    marks.push({ phase: 'end.disarm', status: 'RUNNING' });
    await transitionSession(ctx, sid, {
      from: ['READY', 'RUNNING', 'EXPIRING'],
      to: 'ENDING',
      reason,
      guard: (s) => {
        if (reason === 'EXPIRED' && s.deadlineAt && ctx.nowMs() < Date.parse(s.deadlineAt) - 5000) {
          return err.transitionRejected('EXPIRED before deadlineAt - 5s (02 T10 guard)');
        }
        if (reason === 'IDLE_NOT_STARTED' && s.state !== 'READY') return err.transitionRejected('ready-idle only ends READY sessions');
        return null;
      },
      patch: (s) => ({
        endReason: reason,
        disposition,
        endSeq: ph.seq,
        endPhase: ph.phase,
        endExecutionArns: [...(s.endExecutionArns ?? []), ...(p.executionId ? [p.executionId] : [])],
        ...(disposition === 'keep' && !s.keepRequest ? { keepRequest } : {}),
        ...(disposition === 'keep' && input.keepPrerequisites?.length && !s.keepPrerequisites?.length ? { keepPrerequisites: input.keepPrerequisites } : {}),
        ...phasePatch(ctx, s, marks).patch,
      }),
      events: (s) => [{ type: 'session.end_requested', data: { by: input.actor ?? 'system', reason: endRequestedReason(reason) } }, ...phasePatch(ctx, s, marks).events],
    });
  } else if (s0.state === 'KEPT') {
    reason = input.reason === 'PLATFORM_UNINSTALL' ? 'PLATFORM_UNINSTALL' : input.reason === 'KEEP_EXPIRED' ? 'KEEP_EXPIRED' : 'KEEP_RELEASED';
    const lock = await getLock(ctx);
    const pending = liveReservation(lock, ctx.nowMs());
    if (pending && pending !== sid && reason !== 'PLATFORM_UNINSTALL') {
      // T14 guard (02 §3.4): a new session is taking over this environment — wait (the ASL retries this error)
      throw new WorkflowError('Atl.ReservationActive', `environment ${s0.envId} is reserved by ${pending}`);
    }
    await transitionSession(ctx, sid, {
      from: ['KEPT'],
      to: 'CLEANING',
      reason,
      patch: (s) => ({
        endSeq: ph.seq,
        endPhase: ph.phase,
        disposition: 'destroy',
        endExecutionArns: [...(s.endExecutionArns ?? []), ...(p.executionId ? [p.executionId] : [])],
        ...phasePatch(ctx, s, [{ phase: 'clean.destroy', status: 'QUEUED' }]).patch,
      }),
      events: (s) => [{ type: 'session.end_requested', data: { by: input.actor ?? 'system', reason: 'keep-ended' } }, ...phasePatch(ctx, s, [{ phase: 'clean.destroy', status: 'QUEUED' }]).events],
    });
  } else if (s0.state === 'CLEANUP_FAILED') {
    // T19: back to CLEANING without re-acquiring the lock (02 §2.1); endReason stays (T16 vs T17 later)
    await transitionSession(ctx, sid, {
      from: ['CLEANUP_FAILED'],
      to: 'CLEANING',
      reason: `CLEANUP_RETRY_${ph.k}`,
      patch: (s) => ({
        endSeq: ph.seq,
        endPhase: ph.phase,
        cleanupRetryCount: Math.max(s.cleanupRetryCount ?? 0, ph.k),
        endExecutionArns: [...(s.endExecutionArns ?? []), ...(p.executionId ? [p.executionId] : [])],
        ...phasePatch(ctx, s, [{ phase: 'clean.destroy', status: 'QUEUED' }]).patch,
      }),
    });
    reason = 'CLEANUP_RETRY';
  }
  // ENDING / CLEANING: replay of a started end (context rebuilt from the item)

  const s = await mustGetSession(ctx, sid);
  const env = s.envId ? await getEnvironment(ctx, s.envId) : null;
  const effectiveReason = (s.state === 'CLEANING' && ph.phase === 'retry' ? 'CLEANUP_RETRY' : (s.endReason ?? reason)) as EndReason;
  const fromKeptOrRetry = ph.phase !== 'first' || s.stateReason?.startsWith('CLEANUP_RETRY') === true;
  const mode: ReclaimPassMode = ph.phase === 'retry' ? 'RETRY' : 'PRIMARY';
  const keepHours = s.keepRequest?.hours ?? null;
  const ctxOut: EndContext = {
    sessionId: sid,
    envId: s.envId ?? null,
    envName: env?.envName ?? null,
    labId: s.labId,
    reason: effectiveReason,
    disposition: s.disposition ?? disposition,
    endPhase: ph.phase,
    endSeq: ph.seq,
    startExecutionArn: startArn,
    startExecutionRunning: await isRunning(ctx, startArn),
    skipToCleaning: fromKeptOrRetry,
    needFinalize: s.state === 'ENDING' && !fromKeptOrRetry,
    skipWorkstationDown: !env || (s.workstation?.mode ?? 'ec2') === 'cloudshell',
    hasEnvironment: !!env,
    keep: { saveMode: s.keepRequest?.saveMode ?? true, hours: keepHours },
    budget: (() => {
      const b = envBudget(s.cardSnapshot);
      return { destroyBuildMinutes: b.destroyBuildMinutes, destroyTaskSeconds: b.destroyTaskSeconds };
    })(),
    reclaimMode: mode,
    reclaimName: s.envId ? ExecutionNames.reclaim(s.envId, mode, ph.seq) : null,
  };
  return ctxOut;
}

function currentRunning(s: SessionRecord): string {
  const r = [...(s.phases ?? [])].reverse().find((x) => x.status === 'RUNNING' || x.status === 'RETRYING');
  return r?.name ?? 'provision.base';
}

/** `session.end_requested.reason` (01 §8.4: user / expired / idle / keep-ended / budget / uninstall). */
function endRequestedReason(r: EndReason): string {
  switch (r) {
    case 'EXPIRED':
      return 'expired';
    case 'IDLE_NOT_STARTED':
      return 'idle';
    case 'KEEP_EXPIRED':
    case 'KEEP_RELEASED':
      return 'keep-ended';
    case 'BUDGET_ENFORCED':
      return 'budget';
    case 'PLATFORM_UNINSTALL':
      return 'uninstall';
    default:
      return 'user';
  }
}

/** T04 (REQUESTED → ENDED): release the lock or the reuse reservation of the session. */
export async function cancelRequested(ctx: Ctx, sid: string, reason: EndReason | string): Promise<SessionRecord> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const lock = await getLock(ctx);
    const s = await mustGetSession(ctx, sid);
    if (s.state !== 'REQUESTED') return s;
    const extra: TransactItem[] = [];
    if (lock.holderSessionId === sid && !s.reuseOfEnvId) extra.push(lockWrite(ctx, lock, { holderEnvId: null, holderSessionId: null, acquiredAt: null }));
    else if (lock.pendingSessionId === sid) extra.push(lockWrite(ctx, lock, { pendingSessionId: null, pendingUntil: null }));
    try {
      const r = await transitionSession(ctx, sid, {
        from: ['REQUESTED'],
        to: 'ENDED',
        reason: String(reason),
        patch: () => ({ endReason: (reason === 'PLATFORM_UNINSTALL' ? 'PLATFORM_UNINSTALL' : 'CANCELLED') as EndReason, endedAt: ctx.nowIso(), disposition: 'destroy' }),
        extra: () => extra,
        onExtraFailed: () => err.retryable('lock changed'),
      });
      return r.session;
    } catch (e) {
      if ((e as { name?: string }).name === 'Atl.Retryable') continue;
      throw e;
    }
  }
  throw err.retryable('could not cancel the request');
}

// ---------------------------------------------------------------------------------------------------------------
// StopActiveBuilds, DisarmTimers

export async function stopActiveBuilds(ctx: Ctx, p: { sessionId: string; envId: string | null }) {
  if (!p.envId) return { stopped: 0 };
  const env = await getEnvironment(ctx, p.envId);
  const builds = await ctx.clouds().lifecycle.listActiveBuilds({ envId: p.envId, sessionIds: env?.sessionChain ?? [p.sessionId] });
  for (const b of builds) await ctx.ports.runner.stopBuild(b).catch(() => undefined);
  return { stopped: builds.length };
}

export async function disarmTimers(ctx: Ctx, p: { sessionId: string }) {
  const s = await mustGetSession(ctx, p.sessionId);
  await deleteSchedules(ctx, allScheduleNames(s.sid, s.deadlineVersion ?? 1, s.keep?.version ?? 0));
  await mutateSession(ctx, s.sid, (cur) => {
    const ph = phasePatch(ctx, cur, [{ phase: 'end.disarm', status: 'DONE' }]);
    return ph.events.length ? { patch: ph.patch, events: ph.events } : null;
  });
  return {};
}

// ---------------------------------------------------------------------------------------------------------------
// CloseLearnerAccess / SealRevocation (02 §6.3)

/** IAM changes are eventually consistent: revokedAt = write time + propagation margin (02 §6.3 step 3). */
export const REVOCATION_PROPAGATION_MS = 2 * MINUTE;

export async function closeLearnerAccess(ctx: Ctx, p: { sessionId: string }) {
  const s = await mustGetSession(ctx, p.sessionId);
  const cloud = ctx.clouds().lifecycle;
  const cfg = await getConfig(ctx);
  const env = s.envId ? await getEnvironment(ctx, s.envId) : null;
  // 1. cut the workstation off from the learner role
  await cloud.untagWorkstationRole(s.sid);
  // 2. deny the session (and not yet revoked sessions of the hand-over chain), keeping the result-upload exemption
  const state = await cloud.getRevocations();
  const nowIso = ctx.nowIso();
  if (state.finalizing && state.finalizing.sid !== s.sid) state.revoked[state.finalizing.sid] = state.finalizing.since;
  for (const other of env?.sessionChain ?? []) if (other !== s.sid && !state.revoked[other]) state.revoked[other] = nowIso;
  const finalize = s.state === 'ENDING';
  if (finalize) {
    state.finalizing = {
      sid: s.sid,
      since: nowIso,
      exemptResource: uploadExemptResource({ region: ctx.env.region, accountId: ctx.env.accountId, agentApiEndpoint: cfg.agentApiEndpoint, sid: s.sid }),
    };
    delete state.revoked[s.sid];
  } else {
    state.finalizing = state.finalizing?.sid === s.sid ? null : state.finalizing;
    state.revoked[s.sid] = state.revoked[s.sid] ?? nowIso;
  }
  await cloud.putRevocations(state);
  const revokedAt = s.revokedAt ?? new Date(ctx.nowMs() + REVOCATION_PROPAGATION_MS).toISOString();
  // 3./4. terminate Session Manager sessions on the lab instances and the workstation
  const targets = (env?.instances ?? []).map((i) => i.instanceId);
  if (targets.length) await cloud.terminateSsmSessions({ sid: s.sid, targets });
  // 5. void the platform-side grants
  await revokeGrants(ctx, s.sid, revokedAt);
  const names = [RoleSessionNames.console(s.sid), RoleSessionNames.term(s.sid), RoleSessionNames.ws(s.sid)];
  await mutateSession(ctx, s.sid, (cur) => {
    const ph = phasePatch(ctx, cur, [{ phase: 'end.revoke', status: 'DONE' }]);
    return {
      patch: { ...ph.patch, revokedAt: cur.revokedAt ?? revokedAt, revocation: { state: finalize ? 'FINALIZING' : 'SEALED', at: nowIso, roleSessionNames: names } },
      events: [{ type: 'session.access_revoked', data: { revokedAt: cur.revokedAt ?? revokedAt, roleSessionNames: names } }, ...ph.events],
    };
  });
  return {};
}

export async function sealRevocation(ctx: Ctx, p: { sessionId: string }) {
  const s = await mustGetSession(ctx, p.sessionId);
  const cloud = ctx.clouds().lifecycle;
  const state = await cloud.getRevocations();
  if (state.finalizing?.sid === s.sid || !state.revoked[s.sid]) {
    state.revoked[s.sid] = state.finalizing?.sid === s.sid ? state.finalizing.since : ctx.nowIso();
    if (state.finalizing?.sid === s.sid) state.finalizing = null;
    await cloud.putRevocations(state);
  }
  await mutateSession(ctx, s.sid, (cur) => {
    const marks: Mark[] = [{ phase: 'end.seal', status: 'DONE' }];
    if ((cur.phases ?? []).some((x) => x.name === 'end.finalize' && x.status !== 'FAILED')) marks.unshift({ phase: 'end.finalize', status: 'DONE' });
    const ph = phasePatch(ctx, cur, marks);
    return { patch: { ...ph.patch, revocation: { ...(cur.revocation ?? { roleSessionNames: [] }), state: 'SEALED', at: ctx.nowIso() } }, events: ph.events };
  });
  return {};
}

// ---------------------------------------------------------------------------------------------------------------
// EnterKept (T11)

export async function enterKept(ctx: Ctx, p: { sessionId: string; suspend?: { status?: string; Error?: string } | null }) {
  const s = await mustGetSession(ctx, p.sessionId);
  if (s.state === 'KEPT') return {};
  if (s.state !== 'ENDING' || s.disposition !== 'keep' || !s.keepRequest) throw new WorkflowError('Atl.KeepNotAllowed', 'the session is not ending with a keep request');
  const cfg = await getConfig(ctx);
  const env = s.envId ? await getEnvironment(ctx, s.envId) : null;
  const hours = Math.min(s.keepRequest.hours, keepHoursLimit(s.cardSnapshot, cfg));
  const until = ctx.nowMs() + hours * 60 * MINUTE;
  if (hours <= 0) throw new WorkflowError('Atl.KeepNotAllowed', 'keep hours exceed the limits');
  if (!env || (env.maxAgeUntil && Date.parse(env.maxAgeUntil) < until)) throw new WorkflowError('Atl.KeepNotAllowed', 'the environment reached its maximum age (02 §8.5)');
  if (cfg.mode === 'UNINSTALLING' || (cfg.budget.state === 'EXCEEDED' && cfg.budget.enforcement !== 'notify')) throw new WorkflowError('Atl.KeepNotAllowed', 'keeping is blocked (budget or uninstall)');
  const suspended = p.suspend?.status === 'SUCCEEDED';
  const keep = { until: new Date(until).toISOString(), version: 1, saveMode: suspended, confirmedAt: s.keepRequest.confirmedAt, quoteId: s.keepRequest.quoteId ?? '' };
  await createSchedules(ctx, keepSchedules(s.sid, until, 1));
  await transitionSession(ctx, s.sid, {
    from: ['ENDING'],
    to: 'KEPT',
    reason: 'KEEP_CONFIRMED',
    patch: (cur) => ({ keep, ...phasePatch(ctx, cur, [{ phase: 'end.suspend', status: suspended ? 'DONE' : 'SKIPPED' }]).patch }),
    extra: () => [environmentUpdate(ctx, env, { status: 'KEPT', keepUntil: keep.until, saveMode: suspended })],
    events: () => [{ type: 'session.keep_started', data: { keepUntil: keep.until, saveMode: suspended } }],
  });
  return {};
}

// ---------------------------------------------------------------------------------------------------------------
// EnterCleaning (Transition → CLEANING from ENDING / PROVISIONING / KEPT / CLEANUP_FAILED / CLEANING)

export async function enterCleaning(ctx: Ctx, p: { sessionId: string; from: string[]; reason: string }) {
  const s0 = await mustGetSession(ctx, p.sessionId);
  if (s0.state === 'CLEANING') {
    await mutateEnvironmentStatus(ctx, s0, 'RELEASING');
    return { session: { state: 'CLEANING' } };
  }
  const r = await transitionSession(ctx, s0.sid, {
    from: p.from as SessionRecord['state'][],
    to: 'CLEANING',
    reason: p.reason,
    patch: (s) => ({ disposition: 'destroy', ...phasePatch(ctx, s, [{ phase: 'clean.destroy', status: 'RUNNING' }]).patch }),
    events: (s) => phasePatch(ctx, s, [{ phase: 'clean.destroy', status: 'RUNNING' }]).events,
  });
  await mutateEnvironmentStatus(ctx, r.session, 'RELEASING');
  return { session: { state: r.session.state } };
}

async function mutateEnvironmentStatus(ctx: Ctx, s: SessionRecord, status: 'RELEASING' | 'RELEASED' | 'RELEASE_FAILED'): Promise<void> {
  if (!s.envId) return;
  await mutateEnvironment(ctx, s.envId, (env) => (env.status === status ? null : { status, ...(status !== 'RELEASING' ? { releasedAt: ctx.nowIso(), keepUntil: null } : { keepUntil: null }) }));
}

// ---------------------------------------------------------------------------------------------------------------
// Conclude (6.7) and EmergencyConclude

export async function conclude(ctx: Ctx, p: { sessionId: string; summary: ReclaimSummary }) {
  const s0 = await mustGetSession(ctx, p.sessionId);
  if (s0.state !== 'CLEANING') {
    if (['ENDED', 'FAILED', 'CLEANUP_FAILED'].includes(s0.state)) return { finalState: s0.state, rescanAt: s0.reclaim?.rescanAt ?? [], startRescan: false };
    throw err.transitionRejected(`session ${s0.sid} is ${s0.state}, not CLEANING`);
  }
  const summary = p.summary;
  const finalState = concludeState(s0.endReason ?? null, summary);
  const cfg = await getConfig(ctx);
  const env = s0.envId ? await getEnvironment(ctx, s0.envId) : null;
  const firstConclude = !s0.reclaim;
  const revokedMs = s0.revokedAt ? Date.parse(s0.revokedAt) : ctx.nowMs();
  const rescanAt = s0.reclaim?.rescanAt ?? (env ? rescanTimes(revokedMs, cfg.reclaim.rescanOffsetsMinutes) : []);
  const reclaim = env ? (s0.reclaim ?? { followUp: 'PENDING' as const, rescanAt }) : null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const lock = await getLock(ctx);
    const release = lockReleaseIfHolder(ctx, lock, { envId: s0.envId ?? null, sid: s0.sid });
    const freshEnv = s0.envId ? await getEnvironment(ctx, s0.envId) : null;
    try {
      await transitionSession(ctx, s0.sid, {
        from: ['CLEANING'],
        to: finalState,
        reason: finalState === 'CLEANUP_FAILED' ? 'RESIDUE_BLOCKING' : 'RECLAIM_VERIFIED',
        patch: (s) => ({
          endedAt: s.endedAt ?? ctx.nowIso(),
          cleanup: {
            passes: (s.cleanup?.passes ?? 0) + (summary.passNo > 0 ? 1 : 0),
            deleted: (s.cleanup?.deleted ?? 0) + summary.deleted,
            manual: summary.manual,
            failed: summary.blocking,
            blocking: summary.blocking,
            review: summary.review,
            hourlyBlocking: summary.hourlyBlocking,
          },
          ...(reclaim ? { reclaim } : {}),
          ...phasePatch(ctx, s, [
            { phase: 'clean.reclaim', status: 'DONE' },
            { phase: 'clean.verify', status: summary.blocking > 0 ? 'FAILED' : 'DONE' },
            { phase: 'clean.conclude', status: 'DONE' },
          ]).patch,
        }),
        extra: () => [
          ...(release ? [release] : []),
          ...(freshEnv ? [environmentUpdate(ctx, freshEnv, { status: finalState === 'CLEANUP_FAILED' ? 'RELEASE_FAILED' : 'RELEASED', releasedAt: ctx.nowIso(), keepUntil: null })] : []),
        ],
        onExtraFailed: () => err.retryable('lock or environment changed'),
        events: () => [
          {
            type: finalState === 'CLEANUP_FAILED' ? 'cleanup.failed' : 'cleanup.completed',
            data: { deleted: summary.deleted, manual: summary.manual, blocking: summary.blocking, hourlyBlocking: summary.hourlyBlocking },
          },
        ],
      });
      break;
    } catch (e) {
      if ((e as { name?: string }).name === 'Atl.Retryable' && attempt < 4) continue;
      throw e;
    }
  }
  if (finalState === 'CLEANUP_FAILED') {
    await ctx.clouds().lifecycle.notify(
      'atl-alerts',
      `ATL: session ${s0.sid} left resources behind`,
      `Session ${s0.sid} (${s0.labId}) ended with ${summary.blocking} BLOCKING resources (${summary.hourlyBlocking} billed hourly). See GET /api/v1/sessions/${s0.sid}/cleanup.`,
    ).catch(() => undefined);
  }
  if (!firstConclude && s0.reclaim?.followUp === 'DONE' && finalState !== 'CLEANUP_FAILED' && s0.envId) {
    // the rescan window already closed while the session was CLEANUP_FAILED: drop the state prefix now (9.5)
    await ctx.ports.invoker.invoke('atl-reaper', { action: 'PurgeEnvState', envId: s0.envId, sessionId: s0.sid }).catch(() => undefined);
  }
  return { finalState, rescanAt, startRescan: firstConclude && !!env };
}

/** Workflow error: CLEANUP_FAILED (WORKFLOW_ERROR) with one BLOCKING item “environment state unknown” (02 §6.6). */
export async function emergencyConclude(ctx: Ctx, p: { sessionId: string; error?: SfnError | null }) {
  const s0 = await mustGetSession(ctx, p.sessionId);
  if (isTerminal(s0.state) || s0.state === 'CLEANUP_FAILED' || s0.state === 'KEPT') return { state: s0.state };
  if (s0.state === 'REQUESTED') {
    await failBeforeProvision(ctx, { sessionId: s0.sid, error: p.error ?? { Error: 'Atl.EndWorkflowError', Cause: 'WORKFLOW_ERROR' } });
    return { state: 'FAILED' };
  }
  if (s0.state === 'ENDING' || s0.state === 'PROVISIONING' || s0.state === 'READY' || s0.state === 'RUNNING' || s0.state === 'EXPIRING') {
    if (s0.state !== 'ENDING' && s0.state !== 'PROVISIONING') {
      await transitionSession(ctx, s0.sid, { from: ['READY', 'RUNNING', 'EXPIRING'], to: 'ENDING', reason: 'WORKFLOW_ERROR', patch: () => ({ endReason: s0.endReason ?? 'ADMIN_ENDED' }) });
    }
    await transitionSession(ctx, s0.sid, { from: ['ENDING', 'PROVISIONING'], to: 'CLEANING', reason: 'WORKFLOW_ERROR', patch: (s) => ({ endReason: s.endReason ?? 'PROVISION_FAILED' }) });
  }
  const s = await mustGetSession(ctx, s0.sid);
  if (s.envId) {
    const key = resourceKey(ctx.env.region, { resourceType: 'ATL::Environment::Unknown', id: s.envId });
    const now = ctx.nowIso();
    await ctx.main.put({
      ...Keys.sessionResource(s.envId, key),
      ...{ GSI2PK: 'RES#MANUAL_REQUIRED', GSI2SK: `${s.envId}#${key}` },
      type: 'SessionResource',
      ver: 1,
      createdAt: now,
      updatedAt: now,
      envId: s.envId,
      resourceKey: key,
      arn: null,
      resourceType: 'ATL::Environment::Unknown',
      region: ctx.env.region,
      name: null,
      id: s.envId,
      sessionId: s.sid,
      createdBy: 'provisioner',
      creatorSessionName: null,
      eventId: null,
      eventTime: null,
      discoveredBy: 'STACK',
      sources: ['STACK'],
      billing: 'hourly',
      stage: null,
      cleanupState: 'MANUAL_REQUIRED',
      severity: 'BLOCKING',
      attempts: 0,
      lastError: `environment state unknown: the end workflow failed (${p.error?.Error ?? 'error'})`,
      manualHint: { consoleUrl: 'https://console.aws.amazon.com/cloudformation/home', cli: `aws resourcegroupstaggingapi get-resources --tag-filters Key=atl:env-id,Values=${s.envId}`, note: 'retry the cleanup from the platform' },
    });
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    const lock = await getLock(ctx);
    const release = lockReleaseIfHolder(ctx, lock, { envId: s.envId ?? null, sid: s.sid });
    const env = s.envId ? await getEnvironment(ctx, s.envId) : null;
    try {
      await transitionSession(ctx, s.sid, {
        from: ['CLEANING'],
        to: 'CLEANUP_FAILED',
        reason: 'WORKFLOW_ERROR',
        patch: (cur) => ({
          endedAt: cur.endedAt ?? ctx.nowIso(),
          cleanup: { ...(cur.cleanup ?? { passes: 0, deleted: 0, manual: 0, failed: 0 }), blocking: Math.max(1, cur.cleanup?.blocking ?? 0), failed: Math.max(1, cur.cleanup?.failed ?? 0), hourlyBlocking: Math.max(1, cur.cleanup?.hourlyBlocking ?? 0) },
          cleanupError: { code: 'WORKFLOW_ERROR', error: p.error ?? null, at: ctx.nowIso() },
        }),
        extra: () => [...(release ? [release] : []), ...(env ? [environmentUpdate(ctx, env, { status: 'RELEASE_FAILED', keepUntil: null })] : [])],
        onExtraFailed: () => err.retryable('lock changed'),
        events: () => [{ type: 'cleanup.failed', data: { deleted: 0, manual: 1, blocking: 1, hourlyBlocking: 1, reason: 'WORKFLOW_ERROR' } }],
      });
      break;
    } catch (e) {
      if ((e as { name?: string }).name === 'Atl.Retryable' && attempt < 4) continue;
      if ((e as { name?: string }).name === 'Atl.TransitionRejected') break;
      throw e;
    }
  }
  await ctx.clouds().lifecycle.notify('atl-alerts', `ATL: end workflow error for ${s.sid}`, `Session ${s.sid} is CLEANUP_FAILED (WORKFLOW_ERROR). The sweeper retries automatically.`).catch(() => undefined);
  return { state: 'CLEANUP_FAILED' };
}
