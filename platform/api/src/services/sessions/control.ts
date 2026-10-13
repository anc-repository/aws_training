/**
 * Requests on a running session (02 §5, §6.1, §8): heartbeat (T07/T08), extension and keep quotes, extend, end /
 * cancel / pre-select disposition, keep extend / release, cleanup retry (T19) and “I resolved it” for a ledger item.
 * State changes go through `atl-lifecycle` or the end workflow; atl-api only writes descriptive attributes.
 */
import { AtlError, isTerminal, newUlid, RESOURCE_KEY_RE, type SessionState } from '@atl/shared';
import type { PlatformConfig, SessionItem } from '../../repositories/index.js';
import { isConditionFailed } from '../../repositories/index.js';
import { cardLimitsFromSession, effectiveLimits } from '../catalog/labs.js';
import { priceQuote, quoteExpiresAt, quoteLinesForEnvironment, quoteView } from '../catalog/quotes.js';
import { checkQuote } from './start.js';
import { actorFields, mapDownstreamError } from './lifecycle-client.js';
import { budgetBlocks, sessionLimits } from './view.js';
import type { Actor, ServiceContext } from './types.js';

const COUNTDOWN: readonly SessionState[] = ['READY', 'RUNNING', 'EXPIRING'];
const LAST_SECONDS_MS = 30_000;
const EXPIRING_THRESHOLD_MS = 15 * 60_000;
const HEARTBEAT_WRITE_INTERVAL_MS = 30_000;

function guardPlatform(config: PlatformConfig | null, what: string): void {
  if (config?.mode === 'UNINSTALLING') throw new AtlError('PLATFORM_UNINSTALLING', `${what}: the platform is being uninstalled`);
  if (budgetBlocks(config)) throw new AtlError('BUDGET_BLOCKED', `${what}: the monthly budget is exceeded`);
}

// ---------------------------------------------------------------------------------------------------------------
// Heartbeat (02 §5.6)

export async function heartbeat(ctx: ServiceContext, s: SessionItem, actor: Actor, workbench: boolean): Promise<SessionItem> {
  let cur = s;
  if (workbench && cur.state === 'READY') {
    // T07: first workbench heartbeat
    cur = (await ctx.lifecycle.transition({ sessionId: s.sid, from: ['READY'], to: 'RUNNING', reason: 'WORKBENCH_OPENED' }, actor)) ?? cur;
    cur = (await ctx.repos.sessions.get(s.sid, true)) ?? cur;
  }
  const deadline = typeof cur.deadlineAt === 'string' ? Date.parse(cur.deadlineAt) : null;
  if ((cur.state === 'READY' || cur.state === 'RUNNING') && deadline !== null && deadline - ctx.nowMs <= EXPIRING_THRESHOLD_MS) {
    // T08 seen by a read/write (02 §2.3): the timer will do the same; a rejected transition is fine
    try {
      await ctx.lifecycle.transition({ sessionId: s.sid, from: ['READY', 'RUNNING'], to: 'EXPIRING', reason: 'WARN_15' }, actor);
    } catch (e) {
      if (!(e instanceof AtlError && e.code === 'INVALID_STATE')) throw e;
    }
    cur = (await ctx.repos.sessions.get(s.sid, true)) ?? cur;
  }
  const last = typeof cur.lastHeartbeatAt === 'string' ? Date.parse(cur.lastHeartbeatAt) : 0;
  if (!isTerminal(cur.state) && ctx.nowMs - last >= HEARTBEAT_WRITE_INTERVAL_MS) {
    try {
      cur = await ctx.repos.sessions.updateDescriptive(s.sid, { lastHeartbeatAt: ctx.nowIso, ...(workbench ? { lastWorkbenchAt: ctx.nowIso } : {}) }, [cur.state]);
    } catch (e) {
      if (!isConditionFailed(e)) throw e;
    }
  }
  return cur;
}

// ---------------------------------------------------------------------------------------------------------------
// EXTEND / KEEP quotes (02 §5.4, §8.1)

export async function createSessionQuote(ctx: ServiceContext, s: SessionItem, input: { purpose: 'EXTEND' | 'KEEP'; minutes?: number | undefined; keepHours?: number | undefined }): Promise<Record<string, unknown>> {
  const config = await ctx.repos.platform.config();
  const eff = effectiveLimits(cardLimitsFromSession(s), config);
  let durationMinutes: number;
  let keepHours: number | undefined;
  if (input.purpose === 'EXTEND') {
    if (!COUNTDOWN.includes(s.state)) throw new AtlError('SESSION_EXPIRING_OR_ENDED', `cannot quote an extension while ${s.state}`);
    const limits = sessionLimits(s, eff);
    const minutes = input.minutes ?? eff.extensionMinutes;
    if (limits.extensionsLeft < 1 || limits.extensionMinutesLeft < 1) throw new AtlError('EXTENSION_LIMIT', 'no extensions left');
    if (minutes > Math.min(eff.extensionMinutes, limits.extensionMinutesLeft)) throw new AtlError('LIMIT_EXCEEDED', `at most ${Math.min(eff.extensionMinutes, limits.extensionMinutesLeft)} minutes`);
    durationMinutes = minutes;
  } else {
    if (!['READY', 'RUNNING', 'EXPIRING', 'ENDING', 'KEPT'].includes(s.state)) throw new AtlError('INVALID_STATE', `cannot quote a keep while ${s.state}`);
    if (!eff.keepAllowed) throw new AtlError('KEEP_NOT_ALLOWED', `card ${s.labId} does not allow keeping the environment`);
    keepHours = input.keepHours ?? 1;
    if (keepHours > eff.keepMaxHours) throw new AtlError('LIMIT_EXCEEDED', `keep at most ${eff.keepMaxHours} hours`);
    durationMinutes = keepHours * 60;
  }
  const env = typeof s.envId === 'string' ? await ctx.repos.environments.get(s.envId) : null;
  const ledger = env ? await ctx.repos.environments.resources(env.envId) : [];
  const hourlyManual = ledger.filter((r) => r.billing === 'hourly' && r.createdBy === 'learner' && r.cleanupState !== 'DELETED');
  const lines = quoteLinesForEnvironment(env, hourlyManual);
  const priced = await priceQuote(ctx.deps, {
    purpose: input.purpose,
    region: config?.region ?? ctx.deps.env.region,
    labId: s.labId,
    labVersion: String(s.labVersion ?? ''),
    catalogVersion: String(s.catalogVersion ?? ''),
    variant: String(s.variant ?? 'default'),
    lines,
    durationMinutes,
    maxTotalMinutes: durationMinutes,
    envId: env?.envId ?? null,
    ...(keepHours !== undefined ? { keepHours } : {}),
  });
  const quote = await ctx.repos.users.putQuote(
    s.sub,
    {
      quoteId: newUlid(ctx.nowMs),
      purpose: input.purpose,
      sessionId: s.sid,
      labId: s.labId,
      labVersion: s.labVersion ?? null,
      catalogVersion: s.catalogVersion ?? null,
      variant: s.variant ?? 'default',
      region: config?.region ?? ctx.deps.env.region,
      ...priced,
      durationMinutes,
      maxTotalMinutes: durationMinutes,
      ...(input.purpose === 'EXTEND' ? { minutes: durationMinutes } : { keepHours }),
      issuedAt: ctx.nowIso,
      expiresAt: quoteExpiresAt(ctx.nowMs),
    },
    ctx.nowIso,
  );
  return quoteView(quote);
}

// ---------------------------------------------------------------------------------------------------------------
// Extend (02 §5.4) — through atl-lifecycle.Extend

export async function extend(ctx: ServiceContext, s: SessionItem, actor: Actor, input: { minutes: number; quoteId: string; expectedDeadlineVersion: number }): Promise<SessionItem> {
  const deadline = typeof s.deadlineAt === 'string' ? Date.parse(s.deadlineAt) : null;
  if (!COUNTDOWN.includes(s.state) || deadline === null || ctx.nowMs >= deadline - LAST_SECONDS_MS) {
    throw new AtlError('SESSION_EXPIRING_OR_ENDED', 'the session has expired or is ending; it cannot be extended');
  }
  guardPlatform(await ctx.repos.platform.config(), 'extend');
  if (s.deadlineVersion !== input.expectedDeadlineVersion) {
    throw new AtlError('PRECONDITION_FAILED', `deadlineVersion is ${String(s.deadlineVersion)}, not ${input.expectedDeadlineVersion}`);
  }
  const config = await ctx.repos.platform.config();
  const limits = sessionLimits(s, effectiveLimits(cardLimitsFromSession(s), config));
  if (limits.extensionsLeft < 1 || input.minutes > limits.extensionMinutesLeft) throw new AtlError('EXTENSION_LIMIT', 'the extension count or total extension time is used up');
  if (input.minutes > limits.extensionMinutes) throw new AtlError('LIMIT_EXCEEDED', `at most ${limits.extensionMinutes} minutes per extension`);
  const q = checkQuote(await ctx.repos.users.quote(s.sub, input.quoteId), { purposes: ['EXTEND'], sessionId: s.sid }, ctx.nowMs);
  if (q.minutes !== undefined && q.minutes !== input.minutes) throw new AtlError('QUOTE_MISMATCH', 'minutes differ from the quote');
  await ctx.lifecycle.extend({ sessionId: s.sid, minutes: input.minutes, quoteId: input.quoteId, expectedDeadlineVersion: input.expectedDeadlineVersion }, actor);
  return (await ctx.repos.sessions.get(s.sid, true)) ?? s;
}

// ---------------------------------------------------------------------------------------------------------------
// End / cancel / pre-select (02 §6.1)

export interface EndInput {
  disposition: 'destroy' | 'keep';
  keepHours?: number | undefined;
  quoteId?: string | undefined;
  when: 'now' | 'at-expiry';
  keepPrerequisites?: string[] | undefined;
  saveMode?: boolean | undefined;
}

async function keepRequest(ctx: ServiceContext, s: SessionItem, input: EndInput): Promise<Record<string, unknown>> {
  const config = await ctx.repos.platform.config();
  guardPlatform(config, 'keep');
  const eff = effectiveLimits(cardLimitsFromSession(s), config);
  if (!eff.keepAllowed) throw new AtlError('KEEP_NOT_ALLOWED', `card ${s.labId} does not allow keeping the environment`);
  const hours = input.keepHours;
  if (!hours || hours < 1) throw new AtlError('VALIDATION_FAILED', 'keepHours is required for disposition keep');
  if (hours > eff.keepMaxHours) throw new AtlError('LIMIT_EXCEEDED', `keep at most ${eff.keepMaxHours} hours`);
  if (!input.quoteId) throw new AtlError('VALIDATION_FAILED', 'quoteId (purpose KEEP) is required for disposition keep');
  const q = checkQuote(await ctx.repos.users.quote(s.sub, input.quoteId), { purposes: ['KEEP'], sessionId: s.sid }, ctx.nowMs);
  if (q.keepHours !== undefined && q.keepHours !== hours) throw new AtlError('QUOTE_MISMATCH', 'keepHours differ from the quote');
  return {
    hours,
    quoteId: input.quoteId,
    saveMode: input.saveMode ?? true,
    confirmedAt: ctx.nowIso,
    ...(input.keepPrerequisites?.length ? { keepPrerequisites: input.keepPrerequisites } : {}),
  };
}

export async function endSession(ctx: ServiceContext, s: SessionItem, actor: Actor, input: EndInput): Promise<{ session: SessionItem; started: boolean }> {
  if (input.when === 'at-expiry') {
    if (!COUNTDOWN.includes(s.state)) throw new AtlError('INVALID_STATE', `a disposition at expiry can only be chosen while the countdown runs (${s.state})`);
    const keep = input.disposition === 'keep' ? await keepRequest(ctx, s, input) : null;
    const preferred = {
      disposition: input.disposition,
      keepHours: keep ? (keep.hours as number) : null,
      quoteId: keep ? (keep.quoteId as string) : null,
      keepPrerequisites: (keep?.keepPrerequisites as string[] | undefined) ?? [],
      saveMode: keep ? (keep.saveMode as boolean) : null,
      confirmedAt: ctx.nowIso,
    };
    const updated = await ctx.repos.sessions
      .updateDescriptive(s.sid, { preferredDisposition: preferred }, COUNTDOWN)
      .catch((e: unknown) => {
        if (isConditionFailed(e)) throw new AtlError('INVALID_STATE', 'the session left the countdown');
        throw e;
      });
    return { session: updated, started: false };
  }

  if (s.state === 'REQUESTED') {
    if (input.disposition === 'keep') throw new AtlError('KEEP_NOT_ALLOWED', 'nothing to keep before the environment exists');
    try {
      // T04: cancel before PROVISIONING
      await ctx.lifecycle.transition({ sessionId: s.sid, from: ['REQUESTED'], to: 'ENDED', reason: 'CANCELLED' }, actor);
      return { session: (await ctx.repos.sessions.get(s.sid, true)) ?? s, started: false };
    } catch (e) {
      if (!(e instanceof AtlError && e.code === 'INVALID_STATE')) throw e;
      s = (await ctx.repos.sessions.get(s.sid, true)) ?? s;
      if (s.state !== 'PROVISIONING') throw e;
      // lost the race against T02: cancel as compensation (T06, phase “first”)
    }
  }
  if (s.state === 'PROVISIONING') {
    if (input.disposition === 'keep') throw new AtlError('KEEP_NOT_ALLOWED', 'an environment that is still provisioning cannot be kept');
    const r = await ctx.lifecycle.startSessionEnd(s.sid, { kind: 'first' }, { reason: 'CANCELLED', disposition: 'destroy', ...actorFields(actor) });
    return { session: s, started: !r.alreadyRunning };
  }
  if (COUNTDOWN.includes(s.state)) {
    const keep = input.disposition === 'keep' ? await keepRequest(ctx, s, input) : null;
    const r = await ctx.lifecycle.startSessionEnd(s.sid, { kind: 'first' }, { reason: 'USER_ENDED', disposition: input.disposition, ...(keep ? { keep, keepPrerequisites: keep.keepPrerequisites ?? [] } : {}), ...actorFields(actor) });
    return { session: s, started: !r.alreadyRunning };
  }
  if (s.state === 'ENDING' || s.state === 'CLEANING') return { session: s, started: false };
  throw new AtlError('INVALID_STATE', `cannot end a session in state ${s.state}`);
}

// ---------------------------------------------------------------------------------------------------------------
// Keep (02 §8)

export async function extendKeep(ctx: ServiceContext, s: SessionItem, actor: Actor, input: { hours: number; quoteId: string }): Promise<SessionItem> {
  if (s.state !== 'KEPT') throw new AtlError('INVALID_STATE', `the environment is not kept (${s.state})`);
  const config = await ctx.repos.platform.config();
  guardPlatform(config, 'keep extend');
  const eff = effectiveLimits(cardLimitsFromSession(s), config);
  if (input.hours > eff.keepMaxHours) throw new AtlError('LIMIT_EXCEEDED', `keep at most ${eff.keepMaxHours} hours per extension`);
  const env = typeof s.envId === 'string' ? await ctx.repos.environments.get(s.envId) : null;
  const keep = (s.keep ?? {}) as { until?: string; version?: number };
  const newUntil = Date.parse(keep.until ?? ctx.nowIso) + input.hours * 3_600_000;
  if (env && typeof env.maxAgeUntil === 'string' && newUntil > Date.parse(env.maxAgeUntil)) {
    throw new AtlError('LIMIT_EXCEEDED', `the environment reaches its maximum age at ${env.maxAgeUntil}`);
  }
  const q = checkQuote(await ctx.repos.users.quote(s.sub, input.quoteId), { purposes: ['KEEP'], sessionId: s.sid }, ctx.nowMs);
  if (q.keepHours !== undefined && q.keepHours !== input.hours) throw new AtlError('QUOTE_MISMATCH', 'hours differ from the quote');
  await ctx.lifecycle.extendKeep({ sessionId: s.sid, hours: input.hours, quoteId: input.quoteId, expectedKeepVersion: keep.version ?? 1 }, actor);
  return (await ctx.repos.sessions.get(s.sid, true)) ?? s;
}

export async function releaseKeep(ctx: ServiceContext, s: SessionItem, actor: Actor): Promise<{ started: boolean }> {
  if (s.state !== 'KEPT') throw new AtlError('INVALID_STATE', `the environment is not kept (${s.state})`);
  const lock = await ctx.repos.platform.lock();
  if (lock?.holderSessionId === s.sid && lock.pendingSessionId && lock.pendingUntil && Date.parse(lock.pendingUntil) > ctx.nowMs) {
    throw new AtlError('REUSE_IN_PROGRESS', `the environment is reserved for reuse by session ${lock.pendingSessionId}`, { sessionId: lock.pendingSessionId });
  }
  const r = await ctx.lifecycle.startSessionEnd(s.sid, { kind: 'release' }, { reason: 'KEEP_RELEASED', disposition: 'destroy', ...actorFields(actor) });
  return { started: !r.alreadyRunning };
}

// ---------------------------------------------------------------------------------------------------------------
// Cleanup retry (T19) and “I resolved it” (02 §7.8)

export async function retryCleanup(ctx: ServiceContext, s: SessionItem, actor: Actor): Promise<{ k: number; started: boolean }> {
  if (s.state !== 'CLEANUP_FAILED') throw new AtlError('INVALID_STATE', `cleanup can only be retried in CLEANUP_FAILED (${s.state})`);
  const prev = typeof s.cleanupRetryCount === 'number' ? s.cleanupRetryCount : 0;
  const k = prev + 1;
  try {
    await ctx.repos.sessions.updateDescriptive(s.sid, { cleanupRetryCount: k }, ['CLEANUP_FAILED'], {
      expression: prev === 0 ? 'attribute_not_exists(cleanupRetryCount) OR cleanupRetryCount = :prev' : 'cleanupRetryCount = :prev',
      values: { ':prev': prev },
    });
  } catch (e) {
    if (isConditionFailed(e)) throw new AtlError('INVALID_STATE', 'a cleanup retry was just requested');
    throw e;
  }
  const r = await ctx.lifecycle.startSessionEnd(s.sid, { kind: 'retry', k }, { reason: 'CLEANUP_RETRY', disposition: 'destroy', ...actorFields(actor) });
  return { k, started: !r.alreadyRunning };
}

export async function resolveCleanupItem(ctx: ServiceContext, s: SessionItem, actor: Actor, resourceKey: string, note: string | undefined): Promise<Record<string, unknown>> {
  if (!RESOURCE_KEY_RE.test(resourceKey)) throw new AtlError('NOT_FOUND', 'invalid resourceKey');
  const envIds = [s.envId, s.reuseOfEnvId].filter((x): x is string => typeof x === 'string');
  let item = null;
  let envId: string | null = null;
  for (const e of envIds) {
    item = await ctx.repos.environments.resource(e, resourceKey);
    if (item) {
      envId = e;
      break;
    }
  }
  if (!item || !envId) throw new AtlError('NOT_FOUND', `resource ${resourceKey} is not in this session's ledger`);
  if (!['MANUAL_REQUIRED', 'FAILED', 'REVIEW'].includes(String(item.cleanupState))) {
    throw new AtlError('INVALID_STATE', `resource is ${String(item.cleanupState)}, not waiting for manual handling`);
  }
  try {
    await ctx.deps.ports.invoker.invokeAsync('atl-reaper', { action: 'VerifyResolved', envId, resourceKey, sessionId: s.sid, ...actorFields(actor), note: note ?? null });
  } catch (e) {
    mapDownstreamError(e, 'atl-reaper VerifyResolved');
  }
  return { resourceKey, envId, status: 'verifying' };
}
