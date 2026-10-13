/**
 * atl-lifecycle actions of the start workflow (02 §4): ValidateQuote, AcquireLock, Preflight, EnterProvisioning (the
 * `Transition` to PROVISIONING), ClassifyRunnerFailure, RefreshEnvFacts, CheckSsmOnline, RemediateSsm,
 * WireWorkstation, RunHealthGate, RepairDecision, ArmTimersAndReady, FailBeforeProvision. Each returns every field the
 * ASL references (02 §4.4 constraint 1).
 */
import {
  DataKeys,
  encodeJsonArgs,
  envNameFromEnvId,
  isFinalInvocationStatus,
  newEnvId,
  PROJECT_VALUES,
  RUN_ID_OP_ABBREV,
  StackNames,
  stateUri,
  TAG_KEYS,
  type AtlOp,
  type FailureCode,
} from '@atl/shared';
import type { Ctx } from './context.js';
import { MINUTE } from './context.js';
import { lockBusy, nameOf, WorkflowError, err } from './errors.js';
import { buildFailure, type SfnError } from './failures.js';
import { markPhases, phasePatch } from './phases.js';
import {
  buildBudget,
  buildStatusOf,
  classifyRunnerFailure,
  envBudget,
  initialDeadline,
  MIN_BUILD_MINUTES,
  remainingDeployMinutes,
  type RunnerResultFacts,
} from './rules.js';
import { createSchedules, deadlineSchedules, deleteSchedules, idleSchedule, keepScheduleNames } from './timers.js';
import { environmentCreate, environmentUpdate, getEnvironment, mustGetEnvironment, mutateEnvironment } from './store/environments.js';
import type { EnvironmentRecord, SessionRecord } from './store/model.js';
import { getConfig, getLock, liveReservation, lockWrite } from './store/platform.js';
import { getQuote, putWorkstationGrant, recordRunnerRun, sessionsInState } from './store/records.js';
import { mustGetSession, mutateSession, otherSessionUpdate, publishEvents, transitionSession } from './store/sessions.js';
import { Expr, type TransactItem } from './store/ddb.js';
import type { BuiltEvent } from './store/events.js';

function requireRequested(s: SessionRecord): void {
  if (s.state !== 'REQUESTED') throw err.transitionRejected(`session ${s.sid} is ${s.state}, not REQUESTED`);
}

// ---------------------------------------------------------------------------------------------------------------
// ① ValidateQuote

export async function validateQuote(ctx: Ctx, p: { sessionId: string }) {
  const s = await mustGetSession(ctx, p.sessionId);
  requireRequested(s);
  await markPhases(ctx, s.sid, [{ phase: 'start.validate', status: 'RUNNING' }]);
  const quoteId = s.costQuote?.quoteId;
  if (!quoteId || s.costQuote?.acknowledgedAt === undefined) throw new WorkflowError('Atl.CostNotAcknowledged', 'QUOTE_MISMATCH: the cost was not acknowledged');
  const q = await getQuote(ctx, s.sub, quoteId);
  if (!q) throw new WorkflowError('Atl.QuoteExpired', `QUOTE_EXPIRED: quote ${quoteId} does not exist`);
  if (Date.parse(q.expiresAt) <= ctx.nowMs()) {
    throw new WorkflowError('Atl.QuoteExpired', `QUOTE_EXPIRED: quote ${quoteId} expired at ${q.expiresAt}`);
  }
  const purpose = q.purpose ?? 'START';
  if (purpose !== 'START' && purpose !== 'REUSE') throw new WorkflowError('Atl.QuoteMismatch', `QUOTE_MISMATCH: quote purpose ${purpose}`);
  const mismatch =
    (q.labId && q.labId !== s.labId) ||
    (q.variant && q.variant !== s.variant) ||
    (q.labVersion && q.labVersion !== s.labVersion) ||
    (q.startProfileDigest && s.startProfileDigest && q.startProfileDigest !== s.startProfileDigest) ||
    (purpose === 'REUSE') !== !!s.reuseOfEnvId ||
    (purpose === 'REUSE' && q.reuseEnvironmentId && q.reuseEnvironmentId !== s.reuseOfEnvId);
  if (mismatch) throw new WorkflowError('Atl.QuoteMismatch', 'QUOTE_MISMATCH: the card, variant, start profile or reuse target changed after the quote');
  await markPhases(ctx, s.sid, [{ phase: 'start.validate', status: 'DONE' }]);
  return {
    lab: {
      labId: s.labId,
      kind: s.labKind,
      version: s.labVersion,
      variant: s.variant,
      startProfile: s.startProfile,
      startProfileDigest: s.startProfileDigest,
      timeLimitMinutes: s.cardSnapshot.timeLimitMinutes,
    },
    quote: { quoteId, purpose, expiresAt: q.expiresAt },
    reuseEnvId: s.reuseOfEnvId ?? null,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// ② AcquireLock (02 §3.4)

async function residualCheck(ctx: Ctx, s: SessionRecord): Promise<void> {
  const cfg = await getConfig(ctx);
  if (cfg.reclaim.blockStartOnResidual === 'ignore') return;
  const failed = (await sessionsInState(ctx, 'CLEANUP_FAILED')).filter((x) => x.sid !== s.sid);
  const hourly = failed.reduce((a, x) => a + (x.cleanup?.hourlyBlocking ?? 0), 0);
  const blocking = failed.reduce((a, x) => a + (x.cleanup?.blocking ?? 0), 0);
  if (cfg.reclaim.blockStartOnResidual === 'block' && blocking > 0) {
    throw new WorkflowError('Atl.ResidualAckRequired', `LOCK_BUSY: ${blocking} unreleased resources must be handled first (reclaim.blockStartOnResidual=block)`);
  }
  if (hourly > 0 && !s.residualAck) {
    throw new WorkflowError('Atl.ResidualAckRequired', `LOCK_BUSY: ${hourly} hourly-billed BLOCKING resources remain; start again with residualAck`);
  }
}

export async function acquireLock(ctx: Ctx, p: { sessionId: string; reuseEnvId?: string | null }) {
  const s0 = await mustGetSession(ctx, p.sessionId);
  requireRequested(s0);
  await markPhases(ctx, s0.sid, [{ phase: 'start.lock', status: 'RUNNING' }]);
  const cfg = await getConfig(ctx);
  if (cfg.mode === 'UNINSTALLING') throw new WorkflowError('Atl.PlatformUninstalling', 'LOCK_BUSY: the platform is being uninstalled');
  if (cfg.budget.state === 'EXCEEDED' && cfg.budget.enforcement !== 'notify') throw new WorkflowError('Atl.BudgetBlocked', 'LOCK_BUSY: the monthly budget is exceeded');
  await residualCheck(ctx, s0);
  const reuse = p.reuseEnvId ?? s0.reuseOfEnvId ?? null;

  for (let attempt = 0; attempt < 5; attempt++) {
    const lock = await getLock(ctx);
    const now = ctx.nowMs();
    if (!reuse) {
      if (lock.holderSessionId === s0.sid && lock.holderEnvId) {
        await markPhases(ctx, s0.sid, [{ phase: 'start.lock', status: 'DONE' }]);
        return { envId: lock.holderEnvId, fresh: true };
      }
      if (lock.holderEnvId) {
        const holder = lock.holderSessionId ? await getSessionOrNull(ctx, lock.holderSessionId) : null;
        const stale = !holder || ['ENDED', 'FAILED', 'CLEANUP_FAILED'].includes(holder.state);
        if (!stale) {
          if (holder.state === 'KEPT') throw lockBusy('ENV_KEPT_EXISTS', 'a kept environment exists: release or reuse it', { holderSessionId: holder.sid, labId: holder.labId });
          if (holder.state === 'CLEANING') throw lockBusy('CLEANUP_IN_PROGRESS', 'the previous environment is being reclaimed', { holderSessionId: holder.sid });
          throw lockBusy('SESSION_ACTIVE_EXISTS', 'another session is active', { holderSessionId: holder.sid, labId: holder.labId, deadlineAt: holder.deadlineAt ?? null });
        }
        console.warn(JSON.stringify({ msg: 'taking over a stale ActiveEnvironmentLock', holder: lock.holderSessionId, state: holder?.state ?? null }));
      }
      const envId = await freshEnvId(ctx);
      try {
        await mutateSession(ctx, s0.sid, (s) => {
          requireRequested(s);
          return {
            patch: { envId },
            extra: [lockWrite(ctx, lock, { holderEnvId: envId, holderSessionId: s.sid, acquiredAt: ctx.nowIso(), pendingSessionId: null, pendingUntil: null })],
            onExtraFailed: () => err.retryable('lock changed concurrently'),
          };
        });
      } catch (e) {
        if (nameOf(e) === 'Atl.Retryable') continue;
        throw e;
      }
      await markPhases(ctx, s0.sid, [{ phase: 'start.lock', status: 'DONE' }]);
      return { envId, fresh: true };
    }

    // reuse a KEPT environment: reserve only (pendingSessionId); the hand-over happens in EnterProvisioning
    const env = await getEnvironment(ctx, reuse);
    if (!env || env.status !== 'KEPT') throw new WorkflowError('Atl.ReservationLost', `ENV_NOT_AVAILABLE: environment ${reuse} is not kept`);
    if (env.maxAgeUntil && Date.parse(env.maxAgeUntil) <= now) throw new WorkflowError('Atl.ReservationLost', `ENV_NOT_AVAILABLE: environment ${reuse} reached its maximum age`);
    if (lock.holderEnvId !== reuse || !lock.holderSessionId) throw new WorkflowError('Atl.ReservationLost', `ENV_NOT_AVAILABLE: environment ${reuse} does not hold the lock`);
    const pending = liveReservation(lock, now);
    if (pending === s0.sid) {
      await markPhases(ctx, s0.sid, [{ phase: 'start.lock', status: 'DONE', detail: 'reuse reserved' }]);
      return { envId: reuse, fresh: false };
    }
    if (pending) throw lockBusy('ENV_KEPT_EXISTS', 'another session is already taking over the kept environment', { pendingSessionId: pending });
    const holder = await mustGetSession(ctx, lock.holderSessionId);
    if (holder.state !== 'KEPT') throw new WorkflowError('Atl.ReservationLost', `ENV_NOT_AVAILABLE: session ${holder.sid} is ${holder.state}`);
    const e = new Expr();
    const check: TransactItem = {
      ConditionCheck: {
        TableName: ctx.main.name,
        Key: { PK: holder.PK, SK: holder.SK },
        ConditionExpression: `${e.name('state')} = ${e.value('KEPT')} AND ${e.name('ver')} = ${e.value(holder.ver)}`,
        ...e.input(),
      },
    };
    try {
      await mutateSession(ctx, s0.sid, (s) => {
        requireRequested(s);
        return {
          patch: { envId: reuse },
          extra: [lockWrite(ctx, lock, { pendingSessionId: s.sid, pendingUntil: new Date(now + 5 * MINUTE).toISOString() }), check],
          onExtraFailed: () => err.retryable('lock or kept session changed concurrently'),
        };
      });
    } catch (ex) {
      if (nameOf(ex) === 'Atl.Retryable') continue;
      throw ex;
    }
    await markPhases(ctx, s0.sid, [{ phase: 'start.lock', status: 'DONE', detail: 'reuse reserved' }]);
    return { envId: reuse, fresh: false };
  }
  throw err.retryable('ActiveEnvironmentLock: too many concurrent changes');
}

async function getSessionOrNull(ctx: Ctx, sid: string): Promise<SessionRecord | null> {
  try {
    return await mustGetSession(ctx, sid);
  } catch {
    return null;
  }
}

/** New envId whose envName prefix is unused in the state bucket (02 §9.3: regenerate on collision). */
async function freshEnvId(ctx: Ctx): Promise<string> {
  for (let i = 0; i < 5; i++) {
    const envId = newEnvId(ctx.nowMs());
    const envName = envNameFromEnvId(envId);
    const used = await ctx.ports.objects.list(ctx.env.buckets.labState, `${envName}/`).catch(() => []);
    if (used.length === 0) return envId;
  }
  throw err.retryable('could not find an unused envName');
}

// ---------------------------------------------------------------------------------------------------------------
// ③ Preflight (02 §3.5) — atl-checks runs the read-only checks as ATLVerifierRole

export interface ChecksPreflightResult {
  result: 'PASS' | 'WARN' | 'FAIL';
  failureCode?: FailureCode | null;
  message?: string | null;
  items?: { id: string; level: 'FAIL' | 'WARN' | 'INFO'; message: string; code?: string | null }[];
  warnings?: string[];
  /** a `select: preflight` variant whose `when` holds (02 §3.6), or null */
  variant?: string | null;
  variantDigest?: string | null;
}

export async function preflight(ctx: Ctx, p: { sessionId: string; envId: string; fresh: boolean }) {
  const s = await mustGetSession(ctx, p.sessionId);
  requireRequested(s);
  await markPhases(ctx, s.sid, [{ phase: 'start.preflight', status: 'RUNNING' }]);
  const cfg = await getConfig(ctx);
  const card = s.cardSnapshot;
  if (card.regions.extra.includes('dr-region') && !cfg.drRegion) {
    throw new WorkflowError('Atl.PreflightFailed', 'PREFLIGHT_DR_REGION: the card needs the install parameter DrRegion');
  }
  const inputs = s.learnerInputs ?? {};
  const missing = card.requiredLearnerInputs.filter((id) => inputs[id] === undefined || inputs[id] === null || inputs[id] === '');
  if (missing.length) throw new WorkflowError('Atl.PreflightFailed', `PREFLIGHT_PREREQ: missing learner inputs ${missing.join(', ')}`);
  const r = await ctx.ports.invoker.invoke<ChecksPreflightResult>('atl-checks', {
    action: 'Preflight',
    sessionId: s.sid,
    envId: p.envId,
    fresh: p.fresh,
    labId: s.labId,
    variant: s.variant,
    startProfile: s.startProfile,
    preflightVariants: card.preflightVariants,
    regions: card.regions,
    baseline: p.fresh, // reuse keeps the baseline of the environment's creation (3.5)
  });
  if (r.result === 'FAIL') {
    const code = r.failureCode ?? 'PREFLIGHT_PREREQ';
    const why = r.message ?? (r.items ?? []).filter((i) => i.level === 'FAIL').map((i) => i.message).join('; ');
    throw new WorkflowError('Atl.PreflightFailed', `${code}: ${why || 'account preflight failed'}`);
  }
  const variant = r.variant ?? s.variant;
  const resolved =
    variant === s.variant
      ? { name: s.startProfile, digest: s.startProfileDigest, variant }
      : { name: `atl/${s.labId}/${variant}`, digest: r.variantDigest ?? '', variant };
  const warnings = [...(r.warnings ?? []), ...(r.items ?? []).filter((i) => i.level === 'WARN').map((i) => i.message)];
  await mutateSession(ctx, s.sid, (cur) => {
    requireRequested(cur);
    const ph = phasePatch(ctx, cur, [{ phase: 'start.preflight', status: 'DONE', detail: variant !== s.variant ? `fallback variant ${variant}` : null }]);
    return { patch: { ...ph.patch, startProfileResolved: resolved, preflightWarnings: warnings }, events: ph.events };
  });
  return { warnings, startProfileResolved: resolved };
}

// ---------------------------------------------------------------------------------------------------------------
// EnterProvisioning (T02, and T15 for a reused environment)

export interface EnvContext {
  envId: string;
  envName: string;
  labId: string;
  fresh: boolean;
  applyMode: 'fresh' | 'additive';
  baseOp: 'base-deploy' | 'resume';
  baseRunAbbrev: string;
  workstation: 'ec2' | 'cloudshell';
  startProfile: string;
  extraStacks: { atStart: boolean; argsB64: string | null };
  cfnTags: { Key: string; Value: string }[];
  budget: ReturnType<typeof envBudget>;
}

export function envContextOf(s: SessionRecord, env: Pick<EnvironmentRecord, 'envId' | 'envName'>, fresh: boolean): EnvContext {
  const atStart = s.cardSnapshot.extraStacks.filter((x) => x.deploy === 'start').map((x) => x.id);
  const baseOp: AtlOp = fresh ? 'base-deploy' : 'resume';
  return {
    envId: env.envId,
    envName: env.envName,
    labId: s.labId,
    fresh,
    applyMode: fresh ? 'fresh' : 'additive',
    baseOp,
    baseRunAbbrev: RUN_ID_OP_ABBREV[baseOp],
    workstation: s.workstation?.mode ?? 'ec2',
    startProfile: s.startProfileResolved?.name ?? s.startProfile,
    extraStacks: atStart.length ? { atStart: true, argsB64: encodeJsonArgs({ action: 'deploy', stackIds: atStart }) } : { atStart: false, argsB64: null },
    cfnTags: [
      { Key: TAG_KEYS.project, Value: PROJECT_VALUES.session },
      { Key: TAG_KEYS.sessionId, Value: s.sid },
      { Key: TAG_KEYS.labId, Value: s.labId },
      { Key: TAG_KEYS.envId, Value: env.envId },
      { Key: TAG_KEYS.component, Value: 'env' },
    ],
    budget: envBudget(s.cardSnapshot),
  };
}

/** Regions the reclaimer scans (02 §7.1): platform region ∪ us-east-1 ∪ the card's extra regions. */
export function scanRegions(region: string, drRegion: string | null, card: SessionRecord['cardSnapshot']): string[] {
  const out = new Set<string>([region, 'us-east-1']);
  if (card.regions.extra.includes('dr-region') && drRegion) out.add(drRegion);
  for (const x of card.extraStacks) if (x.region === 'dr-region' && drRegion) out.add(drRegion);
  return [...out];
}

export async function enterProvisioning(ctx: Ctx, p: { sessionId: string; reason?: string; executionId?: string }) {
  const reason = p.reason ?? 'LOCK_ACQUIRED';
  const s0 = await mustGetSession(ctx, p.sessionId);
  if (s0.state === 'PROVISIONING' && s0.stateReason === reason && s0.envId) {
    // replay (the task was retried after the transaction committed)
    const env = await mustGetEnvironment(ctx, s0.envId);
    const fresh = !s0.reuseOfEnvId;
    await ctx.clouds().lifecycle.tagWorkstationRole(s0.sid);
    return { env: envContextOf(s0, env, fresh) };
  }
  if (s0.state !== 'REQUESTED') throw err.transitionRejected(`session ${s0.sid} is ${s0.state}`);
  if (!s0.envId) throw err.transitionRejected(`session ${s0.sid} has no environment lock`);
  const cfg = await getConfig(ctx);
  const fresh = !s0.reuseOfEnvId;
  const envId = s0.envId;
  const nowIso = ctx.nowIso();
  let other: BuiltEvent[] = [];
  let env: EnvironmentRecord;

  if (fresh) {
    const envName = envNameFromEnvId(envId);
    env = {
      PK: '',
      SK: '',
      type: 'Environment',
      ver: 1,
      createdAt: nowIso,
      updatedAt: nowIso,
      envId,
      envName,
      status: 'PROVISIONING',
      ownerSessionId: s0.sid,
      sessionChain: [s0.sid],
      labChain: [s0.labId],
      enabledModules: [],
      stateUri: stateUri(ctx.env.accountId, ctx.env.region, envName),
      stacks: [],
      instances: [],
      endpoints: null,
      maxAgeUntil: new Date(ctx.nowMs() + cfg.limits.envMaxAgeDays * 24 * 60 * MINUTE).toISOString(),
      keepUntil: null,
      saveMode: null,
      platformTags: { [TAG_KEYS.project]: PROJECT_VALUES.session, [TAG_KEYS.component]: 'env', [TAG_KEYS.envId]: envId },
      region: ctx.env.region,
      scanRegions: scanRegions(ctx.env.region, cfg.drRegion, s0.cardSnapshot),
      workstation: { mode: s0.workstation?.mode ?? 'ec2', instanceId: null, stackName: (s0.workstation?.mode ?? 'ec2') === 'ec2' ? StackNames.workstation(s0.sid) : null },
    };
    const lock = await getLock(ctx);
    if (lock.holderSessionId !== s0.sid || lock.holderEnvId !== envId) throw new WorkflowError('Atl.ReservationLost', 'ENV_NOT_AVAILABLE: the lock is no longer held by this session');
    const e = new Expr();
    const lockCheck: TransactItem = {
      ConditionCheck: {
        TableName: ctx.main.name,
        Key: { PK: lock.PK, SK: lock.SK },
        ConditionExpression: `${e.name('holderSessionId')} = ${e.value(s0.sid)} AND ${e.name('holderEnvId')} = ${e.value(envId)}`,
        ...e.input(),
      },
    };
    await transitionSession(ctx, s0.sid, {
      from: ['REQUESTED'],
      to: 'PROVISIONING',
      reason,
      patch: (s) => provisioningPatch(ctx, s, true),
      extra: () => [environmentCreate(ctx, env), lockCheck],
      onExtraFailed: () => new WorkflowError('Atl.ReservationLost', 'ENV_NOT_AVAILABLE: the lock changed before PROVISIONING'),
      events: (s) => phasePatch(ctx, s, provisioningMarks(s, true)).events,
    });
  } else {
    // T15 + T02 in one transaction: lock holder → B, reservation cleared, A KEPT → ENDED (HANDED_OVER), B → PROVISIONING
    const lock = await getLock(ctx);
    if (liveReservation(lock, ctx.nowMs()) !== s0.sid || lock.holderEnvId !== envId || !lock.holderSessionId) {
      throw new WorkflowError('Atl.ReservationLost', 'ENV_NOT_AVAILABLE: the reuse reservation was lost');
    }
    const a = await mustGetSession(ctx, lock.holderSessionId);
    if (a.state !== 'KEPT') throw new WorkflowError('Atl.ReservationLost', `ENV_NOT_AVAILABLE: session ${a.sid} is ${a.state}`);
    const prevEnv = await mustGetEnvironment(ctx, envId);
    env = {
      ...prevEnv,
      status: 'PROVISIONING',
      ownerSessionId: s0.sid,
      sessionChain: [...prevEnv.sessionChain, s0.sid],
      labChain: [...prevEnv.labChain, s0.labId],
      keepUntil: null,
      workstation: { mode: s0.workstation?.mode ?? 'ec2', instanceId: null, stackName: (s0.workstation?.mode ?? 'ec2') === 'ec2' ? StackNames.workstation(s0.sid) : null },
    };
    await transitionSession(ctx, s0.sid, {
      from: ['REQUESTED'],
      to: 'PROVISIONING',
      reason,
      patch: (s) => provisioningPatch(ctx, s, false),
      extra: (s) => {
        const upd = otherSessionUpdate(
          ctx,
          a,
          { state: 'ENDED', stateReason: 'HANDED_OVER', stateEnteredAt: ctx.nowIso(), endReason: 'HANDED_OVER', endedAt: ctx.nowIso() },
          [
            { type: 'session.state_changed', data: { from: 'KEPT', to: 'ENDED', reason: 'HANDED_OVER' } },
            { type: 'session.handed_over', data: { toSessionId: s.sid } },
          ],
        );
        other = upd.built;
        return [
          lockWrite(ctx, lock, { holderEnvId: envId, holderSessionId: s.sid, acquiredAt: ctx.nowIso(), pendingSessionId: null, pendingUntil: null }),
          environmentUpdate(ctx, prevEnv, env),
          ...upd.items,
        ];
      },
      onExtraFailed: () => new WorkflowError('Atl.ReservationLost', 'ENV_NOT_AVAILABLE: the kept environment changed during the hand-over'),
      events: (s) => phasePatch(ctx, s, provisioningMarks(s, false)).events,
    });
    await publishEvents(ctx, other);
    // the kept session's timers are void now
    if (a.keep?.version) await deleteSchedules(ctx, keepScheduleNames(a.sid, a.keep.version));
  }
  await ctx.clouds().lifecycle.tagWorkstationRole(s0.sid);
  const s = await mustGetSession(ctx, s0.sid);
  return { env: envContextOf(s, env, fresh) };
}

function provisioningMarks(s: SessionRecord, fresh: boolean): { phase: string; status: 'RUNNING' | 'SKIPPED' }[] {
  return [
    { phase: fresh ? 'provision.base' : 'provision.resume', status: 'RUNNING' },
    { phase: 'provision.workstation', status: (s.workstation?.mode ?? 'ec2') === 'cloudshell' ? 'SKIPPED' : 'RUNNING' },
  ];
}

function provisioningPatch(ctx: Ctx, s: SessionRecord, fresh: boolean): Partial<SessionRecord> {
  const ph = phasePatch(ctx, s, provisioningMarks(s, fresh));
  return { ...ph.patch, provisioningStartedAt: ctx.nowIso() };
}

// ---------------------------------------------------------------------------------------------------------------
// ClassifyRunnerFailure (02 §4.3, §2.5)

async function readJson(ctx: Ctx, bucket: string, key: string): Promise<Record<string, unknown> | null> {
  const b = await ctx.ports.objects.get(bucket, key).catch(() => null);
  if (!b) return null;
  try {
    return JSON.parse(new TextDecoder().decode(b)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function classifyRunner(
  ctx: Ctx,
  p: { sessionId: string; runId: string; op: string; error?: SfnError | null; attempt: number; maxAttempts: number },
) {
  const s = await mustGetSession(ctx, p.sessionId);
  const result = (await readJson(ctx, ctx.env.buckets.data, DataKeys.runResult(p.runId))) as RunnerResultFacts | null;
  const status = buildStatusOf(p.error ?? null);
  const c = classifyRunnerFailure(p.op, result, status);
  let retry = c.retryable && p.attempt < p.maxAttempts;
  let hint = c.hint;
  let budget = buildBudget(envBudget(s.cardSnapshot).applyBuildMinutes);
  if (p.op === 'profile-apply' || p.op === 'extra-stack') {
    const remaining = remainingDeployMinutes(s.cardSnapshot, s.provisioningStartedAt, ctx.nowMs());
    const lastMinutes = Math.ceil(Number(result?.durationSeconds ?? 0) / 60);
    if (retry && remaining < Math.max(MIN_BUILD_MINUTES, lastMinutes)) {
      retry = false;
      hint = `the deploy budget left (${remaining} min) cannot fit another build`;
    }
    budget = buildBudget(Math.max(0, remaining));
  }
  await recordRunnerRun(ctx, s.sid, p.runId, {
    op: p.op,
    attempt: p.attempt,
    status: status ?? 'FAILED',
    exitCode: result?.exitCode ?? null,
    classification: { retryable: retry, code: c.code, hint },
    resultKey: DataKeys.runResult(p.runId),
  });
  if (retry) {
    const phase = p.op === 'base-deploy' ? 'provision.base' : p.op === 'resume' ? 'provision.resume' : p.op === 'extra-stack' ? 'provision.extra-stack' : p.op === 'destroy' ? 'clean.destroy' : 'provision.profile';
    await markPhases(ctx, s.sid, [{ phase, status: 'RETRYING', detail: hint }]).catch(() => undefined);
  }
  return { retry, code: c.code ?? (c.notAFailure ? null : 'RUNNER_ERROR'), hint, notAFailure: c.notAFailure, repairState: c.repairState, budget };
}

/** Health gate failed: repair once when the budget allows (02 §2.5). */
export async function repairDecision(ctx: Ctx, p: { sessionId: string; attempt: { repair: number }; error?: SfnError }) {
  const s = await mustGetSession(ctx, p.sessionId);
  const remaining = remainingDeployMinutes(s.cardSnapshot, s.provisioningStartedAt, ctx.nowMs());
  const retry = p.attempt.repair < 1 && remaining >= MIN_BUILD_MINUTES;
  if (retry) await markPhases(ctx, s.sid, [{ phase: 'provision.health', status: 'RETRYING', detail: 'health gate failed: repairing once' }]);
  return { retry, code: 'HEALTH_FAILED', budget: buildBudget(Math.max(0, remaining)) };
}

// ---------------------------------------------------------------------------------------------------------------
// RefreshEnvFacts, CheckSsmOnline, RemediateSsm

const ENTRY_OUTPUT_KEYS = ['AppBaseUrl', 'InfoAppBaseUrl', 'InfoAppUrl', 'AppUrl', 'PublicUrl', 'BaseUrl'];

export async function refreshEnvFacts(ctx: Ctx, p: { sessionId: string; envId: string; attempt?: { apply: number; repair: number } }) {
  const s = await mustGetSession(ctx, p.sessionId);
  const env = await mustGetEnvironment(ctx, p.envId);
  const cloud = ctx.clouds().lifecycle;
  const found = await cloud.discoverInstances({ envId: env.envId, envName: env.envName, sessionIds: env.sessionChain });
  const baseStack = StackNames.base(env.envName);
  const lab = found.filter((i) => i.role === 'lab-app' && i.state === 'running' && (!i.asgName || i.lifecycleState === 'InService'));
  const wsStack = s.workstation?.mode === 'ec2' ? StackNames.workstation(s.sid) : null;
  const ws = wsStack ? found.filter((i) => i.role === 'workstation' && i.stackName === wsStack && i.state !== 'terminated') : [];
  if (lab.length === 0) throw new WorkflowError('Atl.EnvFactsMissing', 'BASE_DEPLOY_FAILED: no running lab instance with atl:env-id / atl:role=lab-app');
  if (wsStack && ws.length === 0) throw new WorkflowError('Atl.EnvFactsMissing', 'WORKSTATION_FAILED: no workstation instance in stack ' + wsStack);
  const outputs = (await cloud.stackOutputs({ stackName: baseStack })) ?? {};
  const baseUrl = ENTRY_OUTPUT_KEYS.map((k) => outputs[k]).find((v) => typeof v === 'string' && v) ?? env.endpoints?.baseUrl ?? null;
  const stacks = [...new Set([...env.stacks, StackNames.toolchain(env.envName), baseStack, ...(wsStack ? [wsStack] : [])])];
  await mutateEnvironment(ctx, env.envId, () => ({
    instances: found.map((i) => ({ instanceId: i.instanceId, role: i.role, state: i.state })),
    endpoints: { ...(env.endpoints ?? {}), baseUrl, https: env.endpoints?.https ?? null },
    stacks,
    workstation: { mode: s.workstation?.mode ?? 'ec2', instanceId: ws[0]?.instanceId ?? null, stackName: wsStack },
  }));
  const round = `${p.attempt?.apply ?? 1}-${p.attempt?.repair ?? 0}`;
  await mutateSession(ctx, s.sid, (cur) => {
    const ph = phasePatch(ctx, cur, [
      { phase: 'provision.profile', status: 'DONE' },
      ...((cur.phases ?? []).some((x) => x.name === 'provision.extra-stack') ? [{ phase: 'provision.extra-stack', status: 'DONE' as const }] : []),
      { phase: 'provision.ssm', status: 'RUNNING' },
    ]);
    return {
      patch: {
        ...ph.patch,
        workstation: { mode: cur.workstation?.mode ?? 'ec2', instanceId: ws[0]?.instanceId ?? null, stackName: wsStack },
        ssmWait: cur.ssmWait?.round === round ? cur.ssmWait : { round, startedAt: ctx.nowIso(), remediated: false },
      },
      events: ph.events,
    };
  });
  return { instanceIds: [...lab.map((i) => i.instanceId), ...ws.map((i) => i.instanceId)] };
}

export async function checkSsmOnline(ctx: Ctx, p: { sessionId: string; envId: string; instanceIds: string[]; attempt?: { apply: number; repair: number } }) {
  const s = await mustGetSession(ctx, p.sessionId);
  const ping = await ctx.clouds().lifecycle.ssmPing(p.instanceIds);
  const allOnline = p.instanceIds.length > 0 && p.instanceIds.every((id) => ping[id] === 'Online');
  const started = s.ssmWait?.startedAt ? Date.parse(s.ssmWait.startedAt) : ctx.nowMs();
  const elapsedSec = Math.max(0, Math.floor((ctx.nowMs() - started) / 1000));
  if (allOnline) await markPhases(ctx, s.sid, [{ phase: 'provision.ssm', status: 'DONE' }]);
  return { allOnline, elapsedSec, remediated: s.ssmWait?.remediated === true, ping };
}

export async function remediateSsm(ctx: Ctx, p: { sessionId: string; envId: string; instanceIds?: string[] }) {
  const s = await mustGetSession(ctx, p.sessionId);
  const env = await mustGetEnvironment(ctx, p.envId);
  const cloud = ctx.clouds().lifecycle;
  const ids = p.instanceIds ?? (env.instances ?? []).map((i) => i.instanceId);
  const ping = await cloud.ssmPing(ids);
  const labIds = new Set((env.instances ?? []).filter((i) => i.role === 'lab-app').map((i) => i.instanceId));
  const offline = ids.filter((id) => ping[id] !== 'Online');
  const reboot = offline.filter((id) => labIds.has(id) || !env.workstation?.instanceId || id !== env.workstation.instanceId);
  const diagnostics: Record<string, unknown>[] = [];
  for (const id of reboot) {
    const out = await cloud.consoleOutput(id).catch(() => null);
    diagnostics.push({ instanceId: id, consoleOutputTail: out ? out.slice(-4000) : null });
  }
  if (reboot.length) await cloud.rebootInstances(reboot);
  await mutateSession(ctx, s.sid, (cur) => {
    const ph = phasePatch(ctx, cur, [{ phase: 'provision.ssm', status: 'RETRYING', detail: 'rebooting the lab instance once' }]);
    return {
      patch: { ...ph.patch, ssmWait: { ...(cur.ssmWait ?? { round: '1-0', startedAt: ctx.nowIso() }), remediated: true }, ssmDiagnostics: diagnostics },
      events: ph.events,
    };
  });
  return { rebooted: reboot };
}

// ---------------------------------------------------------------------------------------------------------------
// WireWorkstation (03 §4.6) and the health gate

export async function wireWorkstation(ctx: Ctx, p: { sessionId: string; envId: string }) {
  const s = await mustGetSession(ctx, p.sessionId);
  if (s.state !== 'PROVISIONING') throw err.transitionRejected(`session ${s.sid} is ${s.state}`);
  const env = await mustGetEnvironment(ctx, p.envId);
  const instanceId = s.workstation?.instanceId ?? env.workstation?.instanceId;
  if (!instanceId) throw new WorkflowError('Atl.WorkstationFailed', 'WORKSTATION_FAILED: no workstation instance');
  await markPhases(ctx, s.sid, [{ phase: 'provision.wire', status: 'RUNNING' }]);
  await putWorkstationGrant(ctx, s.sid);
  const cfg = await getConfig(ctx);
  const { commandId } = await ctx.ports.runCommand.sendCommand({
    documentName: 'ATL-WorkstationSetup',
    instanceIds: [instanceId],
    parameters: { SessionId: s.sid, Region: ctx.env.region, AgentApiEndpoint: cfg.agentApiEndpoint, PlatformOrigin: cfg.platformUrl },
    timeoutSeconds: 180,
    comment: `atl workstation-setup ${s.sid}`,
  });
  const deadline = ctx.nowMs() + 180_000;
  for (;;) {
    let inv;
    try {
      inv = await ctx.ports.runCommand.getInvocation(commandId, instanceId);
    } catch (e) {
      if ((e as { code?: string }).code !== 'NotFound') throw e;
      inv = null;
    }
    if (inv && isFinalInvocationStatus(inv.status)) {
      if (inv.status === 'Success') break;
      throw err.retryable(`ATL-WorkstationSetup ${inv.status}: ${inv.stderr.slice(-500)}`);
    }
    if (ctx.nowMs() > deadline) throw err.retryable('ATL-WorkstationSetup did not finish in time');
    await ctx.ports.clock.sleep(3000);
  }
  await markPhases(ctx, s.sid, [{ phase: 'provision.wire', status: 'DONE' }]);
  return {};
}

export interface ChecksHealthResult {
  status: 'PASS' | 'NOT_READY' | 'FAIL';
  report?: Record<string, unknown>;
  message?: string;
  warnings?: string[];
}

export async function runHealthGate(ctx: Ctx, p: { sessionId: string; envId: string; profile: string }) {
  const s = await mustGetSession(ctx, p.sessionId);
  if (s.state !== 'PROVISIONING') throw err.transitionRejected(`session ${s.sid} is ${s.state}`);
  await markPhases(ctx, s.sid, [{ phase: 'provision.health', status: 'RUNNING' }]);
  const gates = s.workstation?.mode === 'cloudshell' ? ['base.ready', 'caps.profile'] : ['base.ready', 'caps.profile', 'ws.ready'];
  const r = await ctx.ports.invoker.invoke<ChecksHealthResult>('atl-checks', {
    action: 'RunHealthGate',
    sessionId: s.sid,
    envId: p.envId,
    profile: p.profile,
    gates,
    expectedWarnings: s.cardSnapshot.expectedWarnings,
    targetModules: s.targetModules,
  });
  if (r.status === 'NOT_READY') throw new WorkflowError('Atl.HealthNotReady', `HEALTH_FAILED: ${r.message ?? 'not ready yet'}`);
  if (r.status !== 'PASS') throw new WorkflowError('Atl.HealthFailed', `HEALTH_FAILED: ${r.message ?? 'health gate failed'}`, { details: { report: r.report } });
  await markPhases(ctx, s.sid, [{ phase: 'provision.health', status: 'DONE' }], { healthReport: r.report ?? null, healthWarnings: r.warnings ?? [] });
  return { report: r.report ?? {} };
}

// ---------------------------------------------------------------------------------------------------------------
// ArmTimersAndReady (T05)

export async function armTimersAndReady(ctx: Ctx, p: { sessionId: string }) {
  const s = await mustGetSession(ctx, p.sessionId);
  if (s.state === 'READY' && s.stateReason === 'HEALTH_PASSED') return {};
  if (s.state !== 'PROVISIONING') throw err.transitionRejected(`session ${s.sid} is ${s.state}`);
  const cfg = await getConfig(ctx);
  const readyAt = ctx.nowMs();
  const deadline = initialDeadline(readyAt, s.cardSnapshot.timeLimitMinutes);
  // timers first (02 §4.4 T05: create the timers → READY); a lost race leaves version-1 schedules that are discarded
  await createSchedules(ctx, [
    ...deadlineSchedules(s.sid, deadline, 1),
    ...(cfg.limits.readyIdleMinutes > 0 ? [idleSchedule(s.sid, readyAt, cfg.limits.readyIdleMinutes, 1)] : []),
  ]);
  const env = s.envId ? await getEnvironment(ctx, s.envId) : null;
  await transitionSession(ctx, s.sid, {
    from: ['PROVISIONING'],
    to: 'READY',
    reason: 'HEALTH_PASSED',
    patch: (cur) => ({
      ...phasePatch(ctx, cur, [{ phase: 'provision.ready', status: 'DONE' }]).patch,
      readyAt: new Date(readyAt).toISOString(),
      deadlineAt: new Date(deadline).toISOString(),
      deadlineVersion: 1,
      extensions: [],
      app: env?.endpoints?.baseUrl ? { entryUrl: env.endpoints.baseUrl, embeddable: cur.app?.embeddable ?? false } : (cur.app ?? null),
    }),
    extra: () => (env ? [environmentUpdate(ctx, env, { status: 'ACTIVE' })] : []),
    events: (cur) => phasePatch(ctx, cur, [{ phase: 'provision.ready', status: 'DONE' }]).events,
  });
  await ctx.clouds().lifecycle.notify('atl-notify', `ATL: ${s.labId} is ready`, `The lab environment of session ${s.sid} is ready. Deadline ${new Date(deadline).toISOString()}.`).catch(() => undefined);
  return {};
}

// ---------------------------------------------------------------------------------------------------------------
// FailBeforeProvision (T03)

export async function failBeforeProvision(ctx: Ctx, p: { sessionId: string; error?: SfnError | null }) {
  const s = await mustGetSession(ctx, p.sessionId);
  if (s.state !== 'REQUESTED') return { state: s.state }; // cancelled meanwhile (ENDED) or already handled
  for (let attempt = 0; attempt < 5; attempt++) {
    const lock = await getLock(ctx);
    const extra: TransactItem[] = [];
    if (lock.holderSessionId === s.sid && lock.holderEnvId && !s.reuseOfEnvId) {
      extra.push(lockWrite(ctx, lock, { holderEnvId: null, holderSessionId: null, acquiredAt: null }));
    } else if (lock.pendingSessionId === s.sid) {
      extra.push(lockWrite(ctx, lock, { pendingSessionId: null, pendingUntil: null }));
    }
    try {
      await transitionSession(ctx, s.sid, {
        from: ['REQUESTED'],
        to: 'FAILED',
        reason: 'START_REJECTED',
        patch: (cur) => {
          const failure = buildFailure(cur, p.error ?? null, 'WORKFLOW_ERROR');
          return { failure, endedAt: ctx.nowIso(), ...phasePatch(ctx, cur, [{ phase: failure.phase, status: 'FAILED', detail: failure.code }]).patch };
        },
        extra: () => extra,
        onExtraFailed: () => err.retryable('lock changed'),
      });
      return { state: 'FAILED' };
    } catch (e) {
      if (nameOf(e) === 'Atl.Retryable' && attempt < 4) continue;
      if (nameOf(e) === 'Atl.TransitionRejected') return { state: (await mustGetSession(ctx, s.sid)).state };
      throw e;
    }
  }
  return { state: 'FAILED' };
}

