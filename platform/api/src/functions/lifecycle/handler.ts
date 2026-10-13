/**
 * atl-lifecycle — the only writer of LabSession (02 §2.3): state transitions, quotes / lock / preflight / timers /
 * workstation wiring / access revocation / conclusion for the start and end workflows, the API's synchronous requests,
 * BudgetAlert (SNS `atl-budget`) and the `atl-sfn-failed` safety net. Dispatches on `action`; SNS and EventBridge events
 * are recognised by their shape. Unknown actions throw `Atl.NotImplemented`.
 */
import { createActionDispatcher, type ActionHandler, type DepsProvider } from '../../runtime/deps.js';
import { makeCtx } from './context.js';
import { err } from './errors.js';
import {
  beginEnd,
  cancelRequested,
  closeLearnerAccess,
  conclude,
  disarmTimers,
  emergencyConclude,
  enterCleaning,
  enterKept,
  sealRevocation,
  stopActiveBuilds,
  type EndInput,
} from './end.js';
import { beginModuleOp, finishModuleOp, type ModuleOpInput } from './module-op.js';
import { budgetAlert, handleExecutionFailure, noteSweeperRescan, pruneRevocations, recordEnvHealth, repairLock, type SfnStatusEvent } from './ops.js';
import { markPhases, type Mark } from './phases.js';
import {
  closeOutageWindow,
  createSession,
  extend,
  heartbeat,
  keepExtend,
  noteTimerRetrigger,
  openOutageWindow,
  releaseKept,
  requestEnd,
  resolveCleanup,
  retryCleanup,
  type CreateSessionInput,
  type EndRequest,
} from './requests.js';
import {
  acquireLock,
  armTimersAndReady,
  checkSsmOnline,
  classifyRunner,
  enterProvisioning,
  failBeforeProvision,
  preflight,
  refreshEnvFacts,
  remediateSsm,
  repairDecision,
  runHealthGate,
  validateQuote,
  wireWorkstation,
} from './start.js';
import { beginUninstall, finishUninstall, uninstallEndSessions, uninstallStatus } from './uninstall.js';
import { concludeRescan, finishFollowUp } from '../rescan/rescan.js';
import { transitionSession } from './store/sessions.js';
import type { SfnError } from './failures.js';

export const FUNCTION_NAME = 'atl-lifecycle';

type P = Record<string, unknown>;
const s = (v: unknown): string => String(v ?? '');
const sid = (p: P): string => s(p.sessionId);

/** `Transition` (single writer, 01 §7.5): the workflows use PROVISIONING (T02/T15) and CLEANING; the API RUNNING (T07) and ENDED from REQUESTED (T04). */
const transition: ActionHandler = async (p, deps) => {
  const ctx = makeCtx(deps, s(p.actor) || 'system');
  const to = s(p.to);
  const from = (Array.isArray(p.from) ? p.from : [p.from]).map((x) => (x === null ? null : s(x)));
  switch (to) {
    case 'PROVISIONING':
      return enterProvisioning(ctx, { sessionId: sid(p), reason: s(p.reason) || 'LOCK_ACQUIRED' });
    case 'CLEANING':
      return enterCleaning(ctx, { sessionId: sid(p), from: from.filter((x): x is string => !!x), reason: s(p.reason) || 'RELEASE' });
    case 'RUNNING': {
      const r = await transitionSession(ctx, sid(p), {
        from: ['READY'],
        to: 'RUNNING',
        reason: s(p.reason) || 'WORKBENCH_OPENED',
        guard: (cur) => (cur.deadlineAt && ctx.nowMs() >= Date.parse(cur.deadlineAt) ? err.transitionRejected('the deadline has passed') : null),
        patch: (cur) => ({ runningAt: cur.runningAt ?? ctx.nowIso() }),
      });
      return r.session; // the API keeps working with the returned item (lifecycle-client `transition`)
    }
    case 'EXPIRING': {
      // T08 (atl-timer WARN_15, or any read / write that sees ≤ 15 minutes left); deadlineVersion must still match
      const dv = p.deadlineVersion === undefined ? null : Number(p.deadlineVersion);
      const r = await transitionSession(ctx, sid(p), {
        from: ['READY', 'RUNNING'],
        to: 'EXPIRING',
        reason: s(p.reason) || 'WARN_15',
        guard: (cur) => (dv !== null && (cur.deadlineVersion ?? 1) !== dv ? err.transitionRejected('stale deadlineVersion') : null),
      });
      return r.session;
    }
    case 'ENDED':
      if (from.includes('REQUESTED')) {
        return cancelRequested(ctx, sid(p), s(p.reason) || 'CANCELLED');
      }
      break;
    default:
      break;
  }
  throw err.invalid(`Transition to ${to} is done by its dedicated action (see platform-lifecycle notes)`);
};

const ctxOf = (p: P, deps: Parameters<ActionHandler>[1]) => makeCtx(deps, s(p.actor) || 'system');

const keepExtendInput = (p: P) => ({
  sessionId: sid(p),
  hours: Number(p.hours),
  quoteId: s(p.quoteId),
  ...(p.expectedKeepVersion !== undefined && p.expectedKeepVersion !== null ? { expectedKeepVersion: Number(p.expectedKeepVersion) } : {}),
});

/**
 * CreateSession accepts both the flat form (`sub`, `labId`, `quoteId`, `costAcknowledged`, `card`, …) and the API
 * client's form (identifiers at the top level plus the full `session` draft, whose `costQuote` records the confirmed
 * quote — the API validated `costAcknowledged` before writing it).
 */
export function createSessionInput(p: P): CreateSessionInput {
  const draft = (p.session && typeof p.session === 'object' ? p.session : {}) as Record<string, unknown>;
  const pick = <T>(...v: unknown[]): T | undefined => v.find((x) => x !== undefined && x !== null) as T | undefined;
  const costQuote = draft.costQuote as { quoteId?: string; acknowledgedAt?: string } | undefined;
  const ws = draft.workstation as { mode?: 'ec2' | 'cloudshell' } | undefined;
  const out: CreateSessionInput = {
    sub: s(pick(p.sub, draft.sub)),
    labId: s(pick(p.labId, draft.labId)),
    quoteId: s(pick(p.quoteId, costQuote?.quoteId)),
    costAcknowledged: p.costAcknowledged === true || (!!costQuote?.acknowledgedAt && p.costAcknowledged !== false),
  };
  const sessionId = pick<string>(p.sessionId, draft.sid);
  const variant = pick<string>(p.variant, draft.variant);
  const reuse = pick<string>(p.reuseEnvironmentId, p.reuseEnvId, draft.reuseOfEnvId);
  const card = pick<CreateSessionInput['card']>(p.card, draft.cardSnapshot);
  const catalogVersion = pick<string>(p.catalogVersion, draft.catalogVersion);
  const workstation = pick<'ec2' | 'cloudshell'>(p.workstation, ws?.mode);
  const trackId = pick<string>(p.trackId, draft.trackId);
  const learnerInputs = pick<Record<string, unknown>>(p.learnerInputs, draft.learnerInputs);
  if (sessionId) out.sessionId = sessionId;
  if (variant) out.variant = variant;
  if (reuse) out.reuseEnvironmentId = reuse;
  if (card) out.card = card;
  if (catalogVersion) out.catalogVersion = catalogVersion;
  if (workstation) out.workstation = workstation;
  if (trackId) out.trackId = trackId;
  if (learnerInputs) out.learnerInputs = learnerInputs;
  if (p.residualAck === true || draft.residualAck === true) out.residualAck = true;
  if (p.startExecution === false) out.startExecution = false;
  return out;
}

export const ACTIONS: Record<string, ActionHandler> = {
  // T01 and API requests
  CreateSession: (p, d) => createSession(ctxOf(p, d), createSessionInput(p)),
  Transition: transition,
  Heartbeat: (p, d) => heartbeat(ctxOf(p, d), { sessionId: sid(p), workbench: p.workbench === true }),
  Extend: (p, d) =>
    extend(ctxOf(p, d), { sessionId: sid(p), minutes: Number(p.minutes), quoteId: s(p.quoteId), expectedDeadlineVersion: Number(p.expectedDeadlineVersion), actor: s(p.actor) || 'user' }),
  RequestEnd: (p, d) => requestEnd(ctxOf(p, d), p as unknown as EndRequest),
  KeepExtend: (p, d) => keepExtend(ctxOf(p, d), keepExtendInput(p)),
  /** the API client's name for KeepExtend (T13) */
  ExtendKeep: (p, d) => keepExtend(ctxOf(p, d), keepExtendInput(p)),
  ReleaseKept: (p, d) => releaseKept(ctxOf(p, d), { sessionId: sid(p), reason: (s(p.reason) || 'KEEP_RELEASED') as 'KEEP_RELEASED', actor: s(p.actor) || 'user' }),
  RetryCleanup: (p, d) =>
    retryCleanup(ctxOf(p, d), {
      sessionId: sid(p),
      actor: s(p.actor) || 'user',
      auto: p.auto === true,
      ...(p.expectedRetryCount !== undefined ? { expectedRetryCount: Number(p.expectedRetryCount) } : {}),
    }),
  ResolveCleanup: (p, d) => resolveCleanup(ctxOf(p, d), { sessionId: sid(p), resourceKey: s(p.resourceKey) }),
  OpenOutageWindow: (p, d) =>
    openOutageWindow(ctxOf(p, d), {
      sessionId: sid(p),
      channel: (s(p.channel) || 'lab') as 'lab',
      maxMinutes: Number(p.maxMinutes ?? 10),
      reason: s(p.reason),
      stepId: (p.stepId as string | undefined) ?? null,
      actionId: (p.actionId as string | undefined) ?? null,
    }),
  CloseOutageWindow: (p, d) =>
    closeOutageWindow(ctxOf(p, d), { sessionId: sid(p), stepId: (p.stepId as string | undefined) ?? null, actionId: (p.actionId as string | undefined) ?? null, expiredOnly: p.expiredOnly === true }),
  BudgetAlert: (p, d) => budgetAlert(ctxOf(p, d), { ...(p.state ? { state: p.state as 'OK' } : {}), message: s(p.message) }),
  HandleExecutionFailure: (p, d) => handleExecutionFailure(ctxOf(p, d), (p.detail ?? p) as SfnStatusEvent),
  PruneRevocations: (p, d) => pruneRevocations(ctxOf(p, d)),
  RecordEnvHealth: (p, d) => recordEnvHealth(ctxOf(p, d), { sessionId: sid(p), status: s(p.status) as 'ok', detail: (p.detail as string | null) ?? null }),
  NoteSweeperRescan: (p, d) => noteSweeperRescan(ctxOf(p, d), { sessionId: sid(p) }),
  RepairLock: (p, d) => repairLock(ctxOf(p, d)),
  NoteTimerRetrigger: async (p, d) => ({ retry: await noteTimerRetrigger(ctxOf(p, d), { sessionId: sid(p), kind: s(p.kind) as 'EXPIRE', version: Number(p.version) }) }),

  // atl-session-start (02 §4.4)
  ValidateQuote: (p, d) => validateQuote(ctxOf(p, d), { sessionId: sid(p) }),
  AcquireLock: (p, d) => acquireLock(ctxOf(p, d), { sessionId: sid(p), reuseEnvId: (p.reuseEnvId as string | null | undefined) ?? null }),
  Preflight: (p, d) => preflight(ctxOf(p, d), { sessionId: sid(p), envId: s(p.envId), fresh: p.fresh !== false }),
  ClassifyRunnerFailure: (p, d) =>
    classifyRunner(ctxOf(p, d), {
      sessionId: sid(p),
      runId: s(p.runId),
      op: s(p.op),
      error: (p.error as SfnError | null | undefined) ?? null,
      attempt: Number(p.attempt ?? 1),
      maxAttempts: Number(p.maxAttempts ?? 1),
    }),
  RepairDecision: (p, d) => repairDecision(ctxOf(p, d), { sessionId: sid(p), attempt: (p.attempt as { repair: number }) ?? { repair: 0 } }),
  RefreshEnvFacts: (p, d) => refreshEnvFacts(ctxOf(p, d), { sessionId: sid(p), envId: s(p.envId), attempt: p.attempt as { apply: number; repair: number } }),
  CheckSsmOnline: (p, d) => checkSsmOnline(ctxOf(p, d), { sessionId: sid(p), envId: s(p.envId), instanceIds: (p.instanceIds as string[]) ?? [] }),
  RemediateSsm: (p, d) => remediateSsm(ctxOf(p, d), { sessionId: sid(p), envId: s(p.envId), instanceIds: p.instanceIds as string[] | undefined }),
  WireWorkstation: (p, d) => wireWorkstation(ctxOf(p, d), { sessionId: sid(p), envId: s(p.envId) }),
  RunHealthGate: (p, d) => runHealthGate(ctxOf(p, d), { sessionId: sid(p), envId: s(p.envId), profile: s(p.profile) }),
  ArmTimersAndReady: (p, d) => armTimersAndReady(ctxOf(p, d), { sessionId: sid(p) }),
  FailBeforeProvision: (p, d) => failBeforeProvision(ctxOf(p, d), { sessionId: sid(p), error: (p.error as SfnError | null) ?? null }),
  MarkPhase: async (p, d) => {
    const extra = p.finalizeError !== undefined ? { finalizeError: p.finalizeError } : {};
    await markPhases(ctxOf(p, d), sid(p), (p.marks as Mark[]) ?? [], extra);
    return {};
  },

  // atl-session-end (02 §6.6)
  BeginEnd: (p, d) => beginEnd(ctxOf(p, d), { input: p.input as EndInput, executionId: s(p.executionId), executionName: s(p.executionName) }),
  StopActiveBuilds: (p, d) => stopActiveBuilds(ctxOf(p, d), { sessionId: sid(p), envId: (p.envId as string | null) ?? null }),
  DisarmTimers: (p, d) => disarmTimers(ctxOf(p, d), { sessionId: sid(p) }),
  CloseLearnerAccess: (p, d) => closeLearnerAccess(ctxOf(p, d), { sessionId: sid(p) }),
  SealRevocation: (p, d) => sealRevocation(ctxOf(p, d), { sessionId: sid(p) }),
  EnterKept: (p, d) => enterKept(ctxOf(p, d), { sessionId: sid(p), suspend: (p.suspend as { status?: string } | null) ?? null }),
  Conclude: (p, d) => conclude(ctxOf(p, d), { sessionId: sid(p), summary: p.summary as never }),
  EmergencyConclude: (p, d) => emergencyConclude(ctxOf(p, d), { sessionId: sid(p), error: (p.error as SfnError | null) ?? null }),

  // atl-reclaim-rescan (02 §7.11)
  ConcludeRescan: (p, d) => concludeRescan(ctxOf(p, d), { sessionId: sid(p), envId: s(p.envId), index: Number(p.index ?? 0), result: (p.result as never) ?? null }),
  FinishFollowUp: (p, d) => finishFollowUp(ctxOf(p, d), { sessionId: sid(p), envId: s(p.envId) }),

  // atl-module-op
  BeginModuleOp: (p, d) => beginModuleOp(ctxOf(p, d), { input: p.input as ModuleOpInput, executionName: s(p.executionName) }),
  FinishModuleOp: (p, d) =>
    finishModuleOp(ctxOf(p, d), {
      sessionId: sid(p),
      opId: (p.opId as string | null) ?? null,
      runId: (p.runId as string | null) ?? null,
      executionName: s(p.executionName),
      status: s(p.status) as 'SUCCEEDED',
      error: (p.error as SfnError | null) ?? null,
    }),

  // atl-platform-uninstall (02 §10.5)
  BeginUninstall: (p, d) => beginUninstall(ctxOf(p, d), { input: (p.input as never) ?? {}, executionName: s(p.executionName) }),
  UninstallEndSessions: (p, d) => uninstallEndSessions(ctxOf(p, d)),
  UninstallStatus: (p, d) => uninstallStatus(ctxOf(p, d), { deadlineAt: (p.deadlineAt as string | null) ?? null }),
  FinishUninstall: (p, d) => finishUninstall(ctxOf(p, d), { result: p.result as { outcome: 'SUCCESS'; reason: string } }),
};

/** SNS (atl-budget) and EventBridge (atl-sfn-failed, raw or wrapped as `ExecutionFailed`) events: map them to their action. */
export function normalizeLifecycleEvent(event: unknown): unknown {
  const e = (event && typeof event === 'object' ? event : {}) as Record<string, unknown>;
  const records = e.Records as { Sns?: { Message?: string } }[] | undefined;
  if (Array.isArray(records) && records[0]?.Sns) return { action: 'BudgetAlert', message: records.map((r) => r.Sns?.Message ?? '').join('\n') };
  if (e['detail-type'] === 'Step Functions Execution Status Change') return { action: 'HandleExecutionFailure', detail: e.detail };
  // the template's atl-sfn-failed rule wraps the event: {"action":"ExecutionFailed","event":<aws.events.event.json>}
  if (e.action === 'ExecutionFailed') {
    const inner = (e.event && typeof e.event === 'object' ? e.event : {}) as Record<string, unknown>;
    return { action: 'HandleExecutionFailure', detail: inner.detail ?? inner };
  }
  return event;
}

export function createLifecycleHandler(getDeps: DepsProvider, actions: Record<string, ActionHandler> = ACTIONS) {
  const dispatch = createActionDispatcher(FUNCTION_NAME, actions, getDeps);
  return (event: unknown) => dispatch(normalizeLifecycleEvent(event));
}
