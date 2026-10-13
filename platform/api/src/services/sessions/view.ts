/**
 * Session view (`GET /sessions/{sid}`, 01 §8.3 — field names as in `LabSession`, 02 §13.1): state, countdown with
 * limits, keep, phases, environment, cost dimensions, allowed actions, progress and resource counters, `serverNow`.
 */
import { ceilToMinute, COUNTDOWN_STATES, isTerminal, type SessionState } from '@atl/shared';
import { apiPath } from '../../http/responses.js';
import type { EnvironmentRecord, Item, PlatformConfig, QuoteItem, ResourceItem, SessionItem } from '../../repositories/index.js';
import { cardLimitsFromSession, effectiveLimits, type EffectiveLimits } from '../catalog/labs.js';
import { QUOTE_DISCLAIMER } from '../catalog/quotes.js';

const DONE_STEP_STATES = ['done', 'done_manual', 'drifted'];

export interface SessionViewInput {
  session: SessionItem;
  env: EnvironmentRecord | null;
  config: PlatformConfig | null;
  quote: QuoteItem | null;
  attempt: Item | null;
  steps: Item[];
  /** Required steps of the card (non-optional), when the content is available. */
  requiredStepIds: string[] | null;
  resources: ResourceItem[];
  nowMs: number;
}

export interface SessionLimitsView {
  extensionsLeft: number;
  extensionMinutes: number;
  extensionMinutesLeft: number;
  maxDeadlineAt: string | null;
  keepAllowed: boolean;
  keepMaxHours: number;
}

const iso = (ms: number) => new Date(ms).toISOString();

/** Countdown limits (02 §5.4): extensions left, the latest possible deadline, keep limits. */
export function sessionLimits(session: SessionItem, eff: EffectiveLimits): SessionLimitsView {
  const used = Array.isArray(session.extensions) ? session.extensions.length : 0;
  const extensionsLeft = Math.max(0, eff.extensionMaxCount - used);
  const readyAt = typeof session.readyAt === 'string' ? Date.parse(session.readyAt) : null;
  let maxDeadlineAt: string | null = null;
  if (readyAt !== null && Number.isFinite(readyAt)) {
    const byExtensions = ceilToMinute(readyAt + eff.timeLimitMinutes * 60_000) + eff.extensionMaxCount * eff.extensionMinutes * 60_000;
    const bySessionCap = readyAt + eff.maxSessionMinutes * 60_000;
    maxDeadlineAt = iso(Math.min(byExtensions, Math.floor(bySessionCap / 60_000) * 60_000));
  }
  let extensionMinutesLeft = extensionsLeft * eff.extensionMinutes;
  if (maxDeadlineAt && typeof session.deadlineAt === 'string') {
    extensionMinutesLeft = Math.max(0, Math.min(extensionMinutesLeft, Math.floor((Date.parse(maxDeadlineAt) - Date.parse(session.deadlineAt)) / 60_000)));
  }
  return { extensionsLeft, extensionMinutes: eff.extensionMinutes, extensionMinutesLeft, maxDeadlineAt, keepAllowed: eff.keepAllowed, keepMaxHours: eff.keepMaxHours };
}

export function budgetBlocks(config: PlatformConfig | null): boolean {
  const b = config?.budget as { state?: string; enforcement?: string } | undefined;
  return b?.state === 'EXCEEDED' && (b.enforcement === 'block-start' || b.enforcement === 'end-active' || b.enforcement === undefined);
}

/** Actions the UI may offer now (01 §8.3 `allowedActions`). The server re-checks every one of them. */
export function allowedActions(session: SessionItem, config: PlatformConfig | null, limits: SessionLimitsView, nowMs: number): string[] {
  const state = session.state;
  const uninstalling = config?.mode === 'UNINSTALLING';
  const blocked = budgetBlocks(config) || uninstalling;
  const out: string[] = [];
  switch (state) {
    case 'REQUESTED':
    case 'PROVISIONING':
      out.push('cancel');
      break;
    case 'READY':
    case 'RUNNING':
    case 'EXPIRING': {
      const deadline = typeof session.deadlineAt === 'string' ? Date.parse(session.deadlineAt) : Number.POSITIVE_INFINITY;
      if (!blocked && limits.extensionMinutesLeft > 0 && nowMs < deadline - 30_000) out.push('extend');
      out.push('end');
      if (!blocked && limits.keepAllowed) out.push('end-keep');
      break;
    }
    case 'KEPT':
      if (!blocked) out.push('keep-extend');
      out.push('keep-release');
      if (!blocked) out.push('reuse');
      break;
    case 'CLEANUP_FAILED':
      out.push('cleanup-retry');
      break;
    default:
      break;
  }
  return out;
}

function instancesOf(env: EnvironmentRecord | null): { lab: unknown[]; workstation: unknown } {
  const list = Array.isArray(env?.instances) ? (env!.instances as Record<string, unknown>[]) : [];
  return {
    lab: list.filter((i) => i.role === 'lab-app' || i.role === undefined),
    workstation: list.find((i) => i.role === 'workstation') ?? null,
  };
}

export function buildSessionView(i: SessionViewInput): Record<string, unknown> {
  const s = i.session;
  const eff = effectiveLimits(cardLimitsFromSession(s), i.config);
  const limits = sessionLimits(s, eff);
  const skipped = new Set(i.steps.filter((st) => st.state === 'skipped' || st.skipped === true).map((st) => String(st.stepId)));
  const doneIds = new Set(i.steps.filter((st) => DONE_STEP_STATES.includes(String(st.state))).map((st) => String(st.stepId)));
  const required = i.requiredStepIds ?? i.steps.map((st) => String(st.stepId));
  const denominator = required.filter((id) => !skipped.has(id));
  const env = i.env;
  const endpoints = (env?.endpoints ?? {}) as { baseUrl?: string | null };
  const app = (s.app ?? null) as { entryUrl?: string | null; embeddable?: boolean } | null;
  const quote = i.quote;
  const hourlyBilled = i.resources.filter((r) => r.billing === 'hourly' && r.cleanupState !== 'DELETED' && r.cleanupState !== 'RESOLVED_BY_LEARNER').length;
  return {
    sessionId: s.sid,
    labId: s.labId,
    labKind: s.labKind ?? null,
    variant: s.variant ?? 'default',
    trackId: s.trackId ?? null,
    catalogVersion: s.catalogVersion ?? null,
    labVersion: s.labVersion ?? null,
    platformVersion: s.platformVersion ?? null,
    state: s.state,
    stateReason: s.stateReason ?? null,
    stateEnteredAt: s.stateEnteredAt,
    ver: s.ver,
    serverNow: iso(i.nowMs),
    createdAt: s.createdAt,
    readyAt: s.readyAt ?? null,
    runningAt: s.runningAt ?? null,
    deadlineAt: s.deadlineAt ?? null,
    deadlineVersion: s.deadlineVersion ?? null,
    extensions: s.extensions ?? [],
    limits,
    keep: s.keep ?? null,
    preferredDisposition: s.preferredDisposition ?? null,
    preferredKeep: s.preferredKeep ?? null,
    startProfile: s.startProfile ?? null,
    startProfileResolved: s.startProfileResolved ?? null,
    outageWindow: s.outageWindow ?? null,
    phases: s.phases ?? [],
    env: env
      ? {
          envId: env.envId,
          envName: env.envName,
          status: env.status,
          appUrl: app?.entryUrl ?? endpoints.baseUrl ?? null,
          hourlyEstimate: quote?.hourly ?? null,
          keepUntil: env.keepUntil ?? null,
          maxAgeUntil: env.maxAgeUntil ?? null,
        }
      : s.envId
        ? { envId: s.envId, envName: null, status: null, appUrl: null, hourlyEstimate: quote?.hourly ?? null }
        : null,
    reuseOfEnvId: s.reuseOfEnvId ?? null,
    cost: quote
      ? {
          quoteId: quote.quoteId,
          currency: quote.currency ?? 'USD',
          priceAsOf: quote.priceAsOf ?? null,
          hourly: quote.hourly ?? null,
          dimensions: ((quote.lines as Record<string, unknown>[] | undefined) ?? []).map((l) => ({
            service: l.service ?? l.ref ?? l.pricingKey ?? null,
            dimension: l.dimension ?? l.billing ?? null,
            detail: l.detail ?? null,
          })),
          incomplete: quote.incomplete ?? [],
          disclaimer: QUOTE_DISCLAIMER,
        }
      : null,
    endpoints: { appEmbeddable: app?.embeddable ?? null, agentApi: i.config?.agentApiEndpoint ?? null },
    targets: instancesOf(env),
    workstation: s.workstation ?? null,
    allowedActions: allowedActions(s, i.config, limits, i.nowMs),
    endReason: s.endReason ?? null,
    disposition: s.disposition ?? null,
    failure: s.failure ?? null,
    revokedAt: s.revokedAt ?? null,
    endedAt: s.endedAt ?? null,
    cleanup: s.cleanup ?? null,
    reclaim: s.reclaim ?? null,
    progress: {
      stepsDone: denominator.filter((id) => doneIds.has(id)).length,
      stepsTotal: denominator.length,
      status: (i.attempt?.status as string | undefined) ?? null,
    },
    resources: { tracked: i.resources.length, hourlyBilled },
    links: {
      self: apiPath('/sessions', s.sid),
      events: apiPath('/sessions', s.sid, '/events'),
      workspace: apiPath('/sessions', s.sid, '/workspace'),
      cleanup: apiPath('/sessions', s.sid, '/cleanup'),
    },
  };
}

/** List item (08 §9.2 #15 fields that the API can fill without extra reads). */
export function sessionListItem(s: SessionItem): Record<string, unknown> {
  const readyAt = typeof s.readyAt === 'string' ? Date.parse(s.readyAt) : null;
  const end = typeof s.endedAt === 'string' ? Date.parse(s.endedAt) : null;
  return {
    sessionId: s.sid,
    labId: s.labId,
    variant: s.variant ?? 'default',
    state: s.state,
    endReason: s.endReason ?? null,
    createdAt: s.createdAt,
    readyAt: s.readyAt ?? null,
    endedAt: s.endedAt ?? null,
    deadlineAt: s.deadlineAt ?? null,
    durationMinutes: readyAt && end ? Math.round((end - readyAt) / 60_000) : null,
    cleanup: s.cleanup ?? null,
    terminal: isTerminal(s.state),
  };
}

export function isCountdown(state: SessionState): boolean {
  return (COUNTDOWN_STATES as readonly SessionState[]).includes(state);
}
