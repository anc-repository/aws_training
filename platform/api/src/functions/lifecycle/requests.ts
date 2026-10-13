/**
 * atl-lifecycle actions behind the browser API (02 §2.3 “API” transitions, §3.3, §5.4, §5.6, §8, §7.8): atl-api calls
 * them synchronously (`lambda:InvokeFunction`), atl-lifecycle stays the only writer of LabSession. Payloads are
 * documented in docs/implementation-notes.md (platform-lifecycle); errors are `Atl.*` names mapped by
 * `LIFECYCLE_ERROR_CODES`.
 */
import {
  ExecutionNames,
  isPortError,
  newSid,
  StackNames,
  terminalStateFor,
  type Disposition,
  type EndReason,
  type OutageChannel,
} from '@atl/shared';
import type { Ctx } from './context.js';
import { MINUTE } from './context.js';
import { err, WorkflowError } from './errors.js';
import { cancelRequested } from './end.js';
import { checkExtension, keepHoursLimit } from './rules.js';
import { createSchedules, deadlineScheduleNames, deadlineSchedules, deleteSchedules, keepScheduleNames, keepSchedules } from './timers.js';
import { loadCardSnapshot } from './store/card.js';
import { getEnvironment, mutateEnvironment } from './store/environments.js';
import type { CardSnapshot, SessionRecord } from './store/model.js';
import { getConfig, getLock, liveReservation } from './store/platform.js';
import { getQuote } from './store/records.js';
import { createSessionItem, getSession, mustGetSession, mutateSession, transitionSession } from './store/sessions.js';

// ---------------------------------------------------------------------------------------------------------------
// CreateSession (T01, 02 §3.3)

export interface CreateSessionInput {
  sessionId?: string;
  sub: string;
  labId: string;
  variant?: string;
  trackId?: string | null;
  quoteId: string;
  costAcknowledged: boolean;
  reuseEnvironmentId?: string | null;
  residualAck?: boolean;
  learnerInputs?: Record<string, unknown> | null;
  workstation?: 'ec2' | 'cloudshell';
  /** card facts resolved by atl-api from the content release; loaded here when absent */
  card?: CardSnapshot;
  catalogVersion?: string | null;
  /** default true: start `start-<sid>` */
  startExecution?: boolean;
}

export async function createSession(ctx: Ctx, p: CreateSessionInput) {
  if (p.costAcknowledged !== true) throw new WorkflowError('Atl.CostNotAcknowledged', 'costAcknowledged must be true');
  if (!p.sub || !p.labId || !p.quoteId) throw err.invalid('sub, labId and quoteId are required');
  const cfg = await getConfig(ctx);
  if (cfg.mode === 'UNINSTALLING') throw new WorkflowError('Atl.PlatformUninstalling', 'the platform is being uninstalled');
  if (cfg.maintenance) throw new WorkflowError('Atl.MaintenanceMode', 'the platform is in maintenance mode');
  if (cfg.budget.state === 'EXCEEDED' && cfg.budget.enforcement !== 'notify') throw new WorkflowError('Atl.BudgetBlocked', 'the monthly budget is exceeded');
  const variant = p.variant ?? 'default';
  const card = p.card ?? (await loadCardSnapshot(ctx, p.labId, variant, p.catalogVersion ?? null));
  if (card.labId !== p.labId || card.variant !== variant) throw new WorkflowError('Atl.VariantUnknown', `card snapshot does not match ${p.labId}/${variant}`);
  const mode = p.workstation ?? 'ec2';
  if (mode === 'cloudshell' && card.workstation.required) throw err.invalid(`card ${p.labId} requires the EC2 workstation`);
  // fast, non-authoritative pre-check of the lock (the authoritative one is AcquireLock, 02 §3.3 step 2)
  const lock = await getLock(ctx);
  if (lock.holderSessionId && lock.holderEnvId !== p.reuseEnvironmentId) {
    const holder = await getSession(ctx, lock.holderSessionId);
    if (holder?.state === 'KEPT') throw new WorkflowError('Atl.EnvKeptExists', `a kept environment exists (${holder.labId})`);
    if (holder?.state === 'CLEANING') throw new WorkflowError('Atl.CleanupInProgress', 'the previous environment is being reclaimed');
    if (holder && !['ENDED', 'FAILED', 'CLEANUP_FAILED'].includes(holder.state)) throw new WorkflowError('Atl.SessionActiveExists', `session ${holder.sid} (${holder.labId}) is active`);
  }
  const sid = p.sessionId ?? newSid();
  const now = ctx.nowIso();
  const record: SessionRecord = {
    PK: '',
    SK: '',
    type: 'LabSession',
    ver: 1,
    createdAt: now,
    updatedAt: now,
    sid,
    sub: p.sub,
    labId: card.labId,
    labKind: card.labKind,
    variant,
    trackId: p.trackId ?? null,
    catalogVersion: card.catalogVersion,
    labVersion: card.labVersion,
    platformVersion: cfg.version,
    envId: null,
    reuseOfEnvId: p.reuseEnvironmentId ?? null,
    startProfile: card.startProfile,
    startProfileDigest: card.startProfileDigest,
    startProfileResolved: null,
    targetModules: card.targetModules,
    cardFacts: { platformActions: card.platformActions.map((a) => a.id), sshFromWorkstation: card.workstation.sshFromWorkstation, sshUser: card.workstation.sshUser },
    cardSnapshot: card,
    outageWindow: null,
    state: 'REQUESTED',
    stateReason: 'CREATED',
    stateEnteredAt: now,
    phases: [],
    extensions: [],
    residualAck: p.residualAck === true,
    learnerInputs: p.learnerInputs ?? null,
    costQuote: { quoteId: p.quoteId, acknowledgedAt: now },
    workstation: { mode, instanceId: null, stackName: mode === 'ec2' ? StackNames.workstation(sid) : null },
    app: null,
    startExecutionArn: null,
    endExecutionArns: [],
    cleanup: null,
    cleanupRetryCount: 0,
    reclaim: null,
  };
  await createSessionItem(ctx, record, []);
  // T01 makes sure the sweeper runs (02 §5.7: it covers REQUESTED / PROVISIONING timeouts)
  await ctx.ports.scheduler.setSweeperEnabled(true);
  let executionArn: string | null = null;
  if (p.startExecution !== false) {
    const r = await ctx.ports.orchestrator.startExecution({ stateMachine: 'atl-session-start', name: ExecutionNames.start(sid), input: { sessionId: sid } });
    executionArn = r.executionArn;
    await mutateSession(ctx, sid, () => ({ patch: { startExecutionArn: executionArn } }));
  }
  return { sessionId: sid, state: 'REQUESTED', ver: 1, executionArn, serverNow: ctx.nowIso() };
}

// ---------------------------------------------------------------------------------------------------------------
// Heartbeat (T07 READY → RUNNING, T08 when ≤ 15 minutes are left)

export async function heartbeat(ctx: Ctx, p: { sessionId: string; workbench?: boolean }) {
  const s = await mustGetSession(ctx, p.sessionId);
  const now = ctx.nowMs();
  const deadline = s.deadlineAt ? Date.parse(s.deadlineAt) : NaN;
  let state = s.state;
  if (p.workbench && s.state === 'READY' && now < deadline) {
    const r = await transitionSession(ctx, s.sid, { from: ['READY'], to: 'RUNNING', reason: 'WORKBENCH_OPENED', patch: (cur) => ({ runningAt: cur.runningAt ?? ctx.nowIso() }) });
    state = r.session.state;
  }
  if ((state === 'READY' || state === 'RUNNING') && deadline - now <= 15 * MINUTE && now < deadline) {
    const r = await transitionSession(ctx, s.sid, { from: ['READY', 'RUNNING'], to: 'EXPIRING', reason: 'REMAINING_LE_15' }).catch(() => null);
    state = r?.session.state ?? state;
  }
  const cur = await mustGetSession(ctx, s.sid);
  return { sessionId: s.sid, state, serverNow: ctx.nowIso(), deadlineAt: cur.deadlineAt ?? null, deadlineVersion: cur.deadlineVersion ?? null };
}

// ---------------------------------------------------------------------------------------------------------------
// Extend (02 §5.4)

async function validQuote(ctx: Ctx, s: SessionRecord, quoteId: string | null | undefined, purpose: 'EXTEND' | 'KEEP'): Promise<void> {
  if (!quoteId) throw new WorkflowError('Atl.CostNotAcknowledged', `a ${purpose} quote is required`);
  const q = await getQuote(ctx, s.sub, quoteId);
  if (!q) throw new WorkflowError('Atl.QuoteExpired', `quote ${quoteId} does not exist`);
  if (Date.parse(q.expiresAt) <= ctx.nowMs()) throw new WorkflowError('Atl.QuoteExpired', `quote ${quoteId} expired`);
  if (q.purpose !== purpose || (q.sessionId && q.sessionId !== s.sid)) throw new WorkflowError('Atl.QuoteMismatch', `quote ${quoteId} is not a ${purpose} quote of ${s.sid}`);
}

export async function extend(ctx: Ctx, p: { sessionId: string; minutes: number; quoteId: string; expectedDeadlineVersion: number; actor?: string }) {
  const s0 = await mustGetSession(ctx, p.sessionId);
  const cfg = await getConfig(ctx);
  const pre = checkExtension(s0, cfg, p, ctx.nowMs());
  if (!pre.ok) throw new WorkflowError(pre.error!, pre.message);
  await validQuote(ctx, s0, p.quoteId, 'EXTEND');
  let newVersion = 0;
  let newDeadline = 0;
  const r = await mutateSession(ctx, s0.sid, (s) => {
    const c = checkExtension(s, cfg, p, ctx.nowMs());
    if (!c.ok) throw new WorkflowError(c.error!, c.message);
    newVersion = (s.deadlineVersion ?? 1) + 1;
    newDeadline = c.newDeadlineMs;
    const back = s.state === 'EXPIRING' && newDeadline - ctx.nowMs() > 15 * MINUTE;
    const to = back ? (s.runningAt ? 'RUNNING' : 'READY') : s.state; // T09
    const at = ctx.nowIso();
    return {
      patch: {
        deadlineAt: new Date(newDeadline).toISOString(),
        deadlineVersion: newVersion,
        extensions: [...(s.extensions ?? []), { at, minutes: p.minutes, quoteId: p.quoteId, actor: p.actor ?? 'user' }],
        ...(back ? { state: to, stateReason: 'EXTENDED', stateEnteredAt: at } : {}),
      },
      events: [
        ...(back ? [{ type: 'session.state_changed' as const, data: { from: 'EXPIRING', to, reason: 'EXTENDED' } }] : []),
        { type: 'session.extended', data: { minutes: p.minutes, deadlineAt: new Date(newDeadline).toISOString(), deadlineVersion: newVersion } },
      ],
    };
  });
  // new version first, then delete the old one (02 §5.4 steps 3–4); a failure here leaves reconciliation to SWEEP
  try {
    await createSchedules(ctx, deadlineSchedules(s0.sid, newDeadline, newVersion));
  } catch (e) {
    throw new WorkflowError('Atl.Unavailable', `extended, but the new schedules could not be created: ${e instanceof Error ? e.message : String(e)}`);
  }
  await deleteSchedules(ctx, deadlineScheduleNames(s0.sid, newVersion - 1));
  return { sessionId: s0.sid, state: r.session.state, deadlineAt: r.session.deadlineAt, deadlineVersion: r.session.deadlineVersion, extensions: r.session.extensions ?? [] };
}

// ---------------------------------------------------------------------------------------------------------------
// End requests (POST /sessions/{sid}/end), keep, release, cleanup retry

export interface EndRequest {
  sessionId: string;
  disposition?: Disposition;
  when?: 'now' | 'at-expiry';
  keepHours?: number | null;
  quoteId?: string | null;
  keepPrerequisites?: string[];
  saveMode?: boolean;
  actor?: string;
  /** ADMIN_ENDED / BUDGET_ENFORCED / PLATFORM_UNINSTALL for non-learner callers */
  reason?: EndReason;
}

async function startEnd(ctx: Ctx, sid: string, name: string, input: Record<string, unknown>): Promise<string | null> {
  try {
    const r = await ctx.ports.orchestrator.startExecution({ stateMachine: 'atl-session-end', name, input });
    return r.executionArn;
  } catch (e) {
    if (isPortError(e, 'ExecutionAlreadyExists')) return ctx.ports.orchestrator.executionArn('atl-session-end', name); // already ending (same phase)
    throw e;
  }
}

export async function requestEnd(ctx: Ctx, p: EndRequest) {
  const s = await mustGetSession(ctx, p.sessionId);
  const cfg = await getConfig(ctx);
  const disposition: Disposition = p.disposition ?? 'destroy';
  let keepRequest: SessionRecord['keepRequest'] = null;
  if (disposition === 'keep') {
    if (!s.cardSnapshot.retain.allowed) throw new WorkflowError('Atl.KeepNotAllowed', `card ${s.labId} does not allow keeping`);
    if (cfg.mode === 'UNINSTALLING') throw new WorkflowError('Atl.PlatformUninstalling', 'the platform is being uninstalled');
    if (cfg.budget.state === 'EXCEEDED' && cfg.budget.enforcement !== 'notify') throw new WorkflowError('Atl.BudgetBlocked', 'the monthly budget is exceeded');
    const hours = p.keepHours ?? 1;
    if (!Number.isFinite(hours) || hours <= 0 || hours > keepHoursLimit(s.cardSnapshot, cfg)) throw new WorkflowError('Atl.LimitExceeded', `keep hours must be within 1..${keepHoursLimit(s.cardSnapshot, cfg)}`);
    await validQuote(ctx, s, p.quoteId, 'KEEP');
    keepRequest = { hours, quoteId: p.quoteId ?? null, saveMode: p.saveMode !== false, confirmedAt: ctx.nowIso() };
  }
  if ((p.when ?? 'now') === 'at-expiry') {
    if (!['READY', 'RUNNING', 'EXPIRING'].includes(s.state)) throw new WorkflowError('Atl.SessionExpiringOrEnded', `session is ${s.state}`);
    await mutateSession(ctx, s.sid, () => ({
      patch: {
        preferredDisposition: { disposition, keepHours: keepRequest?.hours ?? null, quoteId: p.quoteId ?? null, keepPrerequisites: p.keepPrerequisites ?? [] },
        keepRequest,
        keepPrerequisites: p.keepPrerequisites ?? [],
      },
    }));
    return { sessionId: s.sid, state: s.state, executionArn: null };
  }
  switch (s.state) {
    case 'REQUESTED': {
      const after = await cancelRequested(ctx, s.sid, p.reason ?? 'CANCELLED');
      if (after.state === 'REQUESTED' || after.state === 'ENDED') {
        const startArn = s.startExecutionArn ?? ctx.ports.orchestrator.executionArn('atl-session-start', ExecutionNames.start(s.sid));
        await ctx.ports.orchestrator.stopExecution(startArn, { error: 'Atl.Superseded', cause: 'CANCELLED' }).catch(() => undefined);
        return { sessionId: s.sid, state: after.state, executionArn: null };
      }
      // the start workflow entered PROVISIONING meanwhile: cancel as T06
      return requestEnd(ctx, p);
    }
    case 'PROVISIONING': {
      const arn = await startEnd(ctx, s.sid, ExecutionNames.endFirst(s.sid), { sessionId: s.sid, reason: p.reason ?? 'CANCELLED', disposition: 'destroy', actor: p.actor ?? 'user' });
      return { sessionId: s.sid, state: s.state, executionArn: arn };
    }
    case 'READY':
    case 'RUNNING':
    case 'EXPIRING': {
      if (keepRequest || p.keepPrerequisites) {
        await mutateSession(ctx, s.sid, () => ({ patch: { keepRequest, keepPrerequisites: p.keepPrerequisites ?? [] } }));
      }
      const reason: EndReason = p.reason ?? (p.actor === 'admin' ? 'ADMIN_ENDED' : 'USER_ENDED');
      const arn = await startEnd(ctx, s.sid, ExecutionNames.endFirst(s.sid), { sessionId: s.sid, reason, disposition, actor: p.actor ?? 'user' });
      return { sessionId: s.sid, state: s.state, executionArn: arn };
    }
    case 'KEPT':
      return releaseKept(ctx, { sessionId: s.sid, reason: p.reason === 'PLATFORM_UNINSTALL' ? 'PLATFORM_UNINSTALL' : 'KEEP_RELEASED', actor: p.actor });
    case 'ENDING':
    case 'CLEANING':
      return { sessionId: s.sid, state: s.state, executionArn: null };
    default:
      throw new WorkflowError('Atl.SessionExpiringOrEnded', `session is ${s.state}`);
  }
}

export async function keepExtend(ctx: Ctx, p: { sessionId: string; hours: number; quoteId: string; expectedKeepVersion?: number }) {
  const s0 = await mustGetSession(ctx, p.sessionId);
  if (s0.state !== 'KEPT' || !s0.keep) throw err.transitionRejected(`session is ${s0.state}`);
  const cfg = await getConfig(ctx);
  await validQuote(ctx, s0, p.quoteId, 'KEEP');
  const env = s0.envId ? await getEnvironment(ctx, s0.envId) : null;
  const limitMs = keepHoursLimit(s0.cardSnapshot, cfg) * 60 * MINUTE;
  let version = 0;
  let until = 0;
  await mutateSession(ctx, s0.sid, (s) => {
    if (s.state !== 'KEPT' || !s.keep) throw err.transitionRejected(`session is ${s.state}`);
    if (p.expectedKeepVersion !== undefined && p.expectedKeepVersion !== s.keep.version) throw new WorkflowError('Atl.PreconditionFailed', `keep version is ${s.keep.version}`);
    if (!Number.isFinite(p.hours) || p.hours <= 0) throw new WorkflowError('Atl.LimitExceeded', 'hours must be positive');
    until = Date.parse(s.keep.until) + p.hours * 60 * MINUTE;
    const confirmed = Date.parse(s.keep.confirmedAt);
    if (until - confirmed > limitMs) throw new WorkflowError('Atl.LimitExceeded', 'the keep limit would be exceeded');
    if (env?.maxAgeUntil && until > Date.parse(env.maxAgeUntil)) throw new WorkflowError('Atl.LimitExceeded', 'the environment would exceed its maximum age');
    version = s.keep.version + 1;
    const at = ctx.nowIso();
    return {
      patch: { keep: { ...s.keep, until: new Date(until).toISOString(), version, quoteId: p.quoteId }, stateReason: 'KEEP_EXTENDED', stateEnteredAt: s.stateEnteredAt },
      events: [
        { type: 'session.state_changed', data: { from: 'KEPT', to: 'KEPT', reason: 'KEEP_EXTENDED' } }, // T13
        { type: 'session.keep_extended', data: { keepUntil: new Date(until).toISOString(), at } },
      ],
    };
  });
  await createSchedules(ctx, keepSchedules(s0.sid, until, version));
  await deleteSchedules(ctx, keepScheduleNames(s0.sid, version - 1));
  if (s0.envId) await mutateEnvironment(ctx, s0.envId, () => ({ keepUntil: new Date(until).toISOString() }));
  return { sessionId: s0.sid, keepUntil: new Date(until).toISOString(), keepVersion: version };
}

export async function releaseKept(ctx: Ctx, p: { sessionId: string; reason?: 'KEEP_RELEASED' | 'KEEP_EXPIRED' | 'PLATFORM_UNINSTALL'; actor?: string }) {
  const s = await mustGetSession(ctx, p.sessionId);
  if (s.state !== 'KEPT') throw err.transitionRejected(`session is ${s.state}`);
  const reason = p.reason ?? 'KEEP_RELEASED';
  const lock = await getLock(ctx);
  const pending = liveReservation(lock, ctx.nowMs());
  if (pending && pending !== s.sid && reason !== 'PLATFORM_UNINSTALL') throw new WorkflowError('Atl.ReuseInProgress', `session ${pending} is taking over this environment`);
  const arn = await startEnd(ctx, s.sid, ExecutionNames.endRelease(s.sid), { sessionId: s.sid, reason, disposition: 'destroy', actor: p.actor ?? 'user' });
  return { sessionId: s.sid, state: s.state, executionArn: arn };
}

/** T19 (02 §7.8): k = cleanupRetryCount + 1, reserved by a conditional update so that two callers never share a name. */
export async function retryCleanup(ctx: Ctx, p: { sessionId: string; actor?: string; auto?: boolean; expectedRetryCount?: number }) {
  let k = 0;
  await mutateSession(ctx, p.sessionId, (s) => {
    if (s.state !== 'CLEANUP_FAILED') throw err.transitionRejected(`session is ${s.state}`);
    if (p.expectedRetryCount !== undefined && (s.cleanupRetryCount ?? 0) !== p.expectedRetryCount) throw err.transitionRejected('another retry was started meanwhile');
    k = (s.cleanupRetryCount ?? 0) + 1;
    return { patch: { cleanupRetryCount: k, ...(p.auto ? { autoCleanupRetries: (s.autoCleanupRetries ?? 0) + 1 } : {}) } };
  });
  const arn = await startEnd(ctx, p.sessionId, ExecutionNames.endRetry(p.sessionId, k), { sessionId: p.sessionId, reason: 'CLEANUP_RETRY', disposition: 'destroy', actor: p.actor ?? 'user' });
  return { sessionId: p.sessionId, retry: k, executionArn: arn };
}

/** “我已处理” (02 §7.8): atl-reaper re-checks the item; when nothing BLOCKING is left, T20 back to the terminal state. */
export async function resolveCleanup(ctx: Ctx, p: { sessionId: string; resourceKey: string }) {
  const s = await mustGetSession(ctx, p.sessionId);
  if (!s.envId) throw err.notFound('the session has no environment');
  const r = await ctx.ports.invoker.invoke<{ resolved: boolean; remainingBlocking: number }>('atl-reaper', { action: 'ResolveItem', envId: s.envId, resourceKey: p.resourceKey, sessionId: s.sid });
  let state = s.state;
  if (r.remainingBlocking === 0 && s.state === 'CLEANUP_FAILED') {
    const to = terminalStateFor(s.endReason ?? null);
    const t = await transitionSession(ctx, s.sid, {
      from: ['CLEANUP_FAILED'],
      to,
      reason: 'RESOLVED_BY_LEARNER',
      patch: (cur) => ({ cleanup: { ...(cur.cleanup ?? { passes: 0, deleted: 0, manual: 0, failed: 0 }), blocking: 0, failed: 0, hourlyBlocking: 0 } }),
      events: () => [{ type: 'cleanup.completed', data: { deleted: 0, manual: 0, blocking: 0, hourlyBlocking: 0, resolvedBy: 'learner' } }],
    });
    state = t.session.state;
    await mutateEnvironment(ctx, s.envId, () => ({ status: 'RELEASED' }));
  }
  return { ...r, state };
}

// ---------------------------------------------------------------------------------------------------------------
// Expected-outage window (02 §5.8)

export async function openOutageWindow(
  ctx: Ctx,
  p: { sessionId: string; channel: OutageChannel; maxMinutes: number; reason: string; stepId?: string | null; actionId?: string | null },
) {
  const cfg = await getConfig(ctx);
  const r = await mutateSession(ctx, p.sessionId, (s) => {
    if (!['READY', 'RUNNING', 'EXPIRING'].includes(s.state)) throw new WorkflowError('Atl.SessionNotRunning', `session is ${s.state}`);
    const minutes = Math.max(1, Math.min(p.maxMinutes, cfg.outage.maxMinutes));
    let until = ctx.nowMs() + minutes * MINUTE;
    if (s.deadlineAt) until = Math.min(until, Date.parse(s.deadlineAt));
    const prev = s.outageWindow;
    if (prev && Date.parse(prev.until) >= until) return null; // one window at a time, the later `until` wins
    const win = { until: new Date(until).toISOString(), channel: p.channel, reason: p.reason, ...(p.stepId ? { stepId: p.stepId } : {}), ...(p.actionId ? { actionId: p.actionId } : {}) };
    return { patch: { outageWindow: win }, events: [{ type: 'session.outage_window_changed', data: { open: true, ...win } }] };
  });
  return { outageWindow: r.session.outageWindow };
}

export async function closeOutageWindow(ctx: Ctx, p: { sessionId: string; stepId?: string | null; actionId?: string | null; expiredOnly?: boolean }) {
  const r = await mutateSession(ctx, p.sessionId, (s) => {
    const w = s.outageWindow;
    if (!w) return null;
    if (p.expiredOnly && Date.parse(w.until) > ctx.nowMs()) return null;
    if (p.stepId && w.stepId && w.stepId !== p.stepId) return null;
    if (p.actionId && w.actionId && w.actionId !== p.actionId) return null;
    return { patch: { outageWindow: null }, events: [{ type: 'session.outage_window_changed', data: { open: false, until: w.until, channel: w.channel, reason: w.reason } }] };
  });
  return { outageWindow: r.session.outageWindow };
}

// ---------------------------------------------------------------------------------------------------------------
// Timer re-trigger bookkeeping (02 §5.2): the counter lives on the session, written here (single writer)

export async function noteTimerRetrigger(ctx: Ctx, p: { sessionId: string; kind: 'EXPIRE' | 'KEEP_EXPIRE'; version: number }): Promise<number> {
  let k = 0;
  await mutateSession(ctx, p.sessionId, (s) => {
    const key = `${p.kind}:${p.version}`;
    const prev = (s.timerRetriggers as Record<string, number> | undefined) ?? {};
    k = (prev[key] ?? 0) + 1;
    return { patch: { timerRetriggers: { ...prev, [key]: k } } };
  });
  return k;
}

