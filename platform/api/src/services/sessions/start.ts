/**
 * Before and at the start (02 §3): start / reuse quotes (`POST /labs/{labId}/quotes`) and `POST /sessions`
 * (validation, fast pre-check, `atl-lifecycle.CreateSession` (T01), `StartExecution start-<sid>`).
 */
import { AtlError, DEFAULT_VARIANT, isEnvId, newSid, newUlid, type JwtPrincipal, type QuotePurpose } from '@atl/shared';
import type { EnvironmentRecord, QuoteItem, SessionItem } from '../../repositories/index.js';
import { cardFactsOf, cardLimitsOf, effectiveLimits, requiredLearnerInputs, resolveVariant, type ResolvedVariant } from '../catalog/labs.js';
import { priceQuote, quoteExpiresAt, quoteLinesFromLab, quoteView } from '../catalog/quotes.js';
import type { LabContent } from '../catalog/store.js';
import { loadPlatformState, startBlockers, throwBlocker, type Blocker } from './guards.js';
import type { Actor, ServiceContext } from './types.js';

// ---------------------------------------------------------------------------------------------------------------
// Reuse plan (02 §8.4 rule 1)

export interface ReusePlan {
  environmentId: string;
  compatible: boolean;
  reason?: string;
  enable: string[];
  change: { module: string; replacesInstance: boolean | null; downtime: boolean | null }[];
  extraModules: string[];
  manualResources: number;
  failureNote: string;
}

/** `Environment.enabledModules` entries are `<module>` or `<module>:<driver>` / `<module>=<driver>`. */
export function parseEnabledModules(env: EnvironmentRecord | null): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const raw of (Array.isArray(env?.enabledModules) ? env!.enabledModules : []) as unknown[]) {
    if (typeof raw === 'string') {
      const m = /^([a-z0-9-]+)(?:[:=]([A-Za-z0-9_.-]+))?$/.exec(raw);
      if (m) out.set(m[1]!, m[2] ?? null);
    } else if (raw && typeof raw === 'object' && typeof (raw as { id?: unknown }).id === 'string') {
      const r = raw as { id: string; driver?: string };
      out.set(r.id, r.driver ?? null);
    }
  }
  return out;
}

export function reusePlan(env: EnvironmentRecord, lab: LabContent, v: ResolvedVariant, manualResources: number, nowMs: number): ReusePlan {
  const enabled = parseEnabledModules(env);
  const plan: ReusePlan = {
    environmentId: env.envId,
    compatible: true,
    enable: [],
    change: [],
    extraModules: [],
    manualResources,
    failureNote: '交接完成后若新会话在准备阶段失败，补偿会释放整个环境（含上一个会话保留的模块与手工资源），不会退回保留状态（02 §8.4 第 7 条）',
  };
  if (env.status !== 'KEPT') return { ...plan, compatible: false, reason: 'ENV_NOT_KEPT' };
  if (typeof env.maxAgeUntil === 'string' && Date.parse(env.maxAgeUntil) <= nowMs) return { ...plan, compatible: false, reason: 'ENV_TOO_OLD' };
  const sameCardChain = Array.isArray(env.labChain) && (env.labChain as unknown[]).includes(lab.id);
  for (const t of v.targetModules) {
    if (enabled.get(t.id) === t.driver && !sameCardChain) return { ...plan, compatible: false, reason: 'TARGET_ALREADY_SATISFIED' };
  }
  const start = new Set([...(lab.modules?.start ?? []), ...(lab.modules?.context ?? [])]);
  const targets = new Set(v.targetModules.map((t) => t.id));
  plan.enable = [...start].filter((m) => !enabled.has(m));
  plan.extraModules = [...enabled.keys()].filter((m) => !start.has(m) && !targets.has(m) && m !== 'ec2');
  return plan;
}

// ---------------------------------------------------------------------------------------------------------------
// Quotes for a card (START / REUSE)

export interface LabQuoteInput {
  purpose: 'START' | 'REUSE';
  variant?: string | undefined;
  reuseEnvironmentId?: string | undefined;
}

export async function createLabQuote(ctx: ServiceContext, sub: string, labId: string, input: LabQuoteInput): Promise<Record<string, unknown>> {
  const release = await ctx.catalog.requireCurrent();
  const lab = await ctx.catalog.requireLab(labId, release.catalogVersion);
  const v = resolveVariant(lab, input.variant);
  const config = await ctx.repos.platform.config();
  let plan: ReusePlan | null = null;
  if (input.purpose === 'REUSE') {
    if (!input.reuseEnvironmentId || !isEnvId(input.reuseEnvironmentId)) throw new AtlError('VALIDATION_FAILED', 'reuseEnvironmentId is required for purpose REUSE');
    const env = await ctx.repos.environments.get(input.reuseEnvironmentId);
    if (!env) throw new AtlError('NOT_FOUND', `environment ${input.reuseEnvironmentId} not found`);
    const ledger = await ctx.repos.environments.resources(env.envId);
    const manual = ledger.filter((r) => r.createdBy === 'learner' && r.cleanupState !== 'DELETED').length;
    plan = reusePlan(env, lab, v, manual, ctx.nowMs);
  }
  const eff = effectiveLimits(cardLimitsOf(lab), config);
  const durationMinutes = lab.timeLimitMinutes;
  const maxTotalMinutes = Math.min(durationMinutes + eff.extensionMaxCount * eff.extensionMinutes, eff.maxSessionMinutes);
  const lines = quoteLinesFromLab(lab);
  const priced = await priceQuote(ctx.deps, {
    purpose: input.purpose,
    region: config?.region ?? ctx.deps.env.region,
    labId,
    labVersion: lab.version,
    catalogVersion: release.catalogVersion,
    variant: v.variant,
    ...(v.preflightAlternatives.length ? { alternativeVariants: v.preflightAlternatives.map((p) => p.id) } : {}),
    lines,
    durationMinutes,
    maxTotalMinutes,
    ...(plan ? { envId: plan.environmentId } : {}),
  });
  const notes = [...priced.notes];
  for (const alt of v.preflightAlternatives) {
    notes.push(`若账号预检满足条件（${alt.when ?? '见卡片'}），将改用回退档 ${alt.id}；报价按两者中较高者计算`);
  }
  const quoteId = newUlid(ctx.nowMs);
  const quote = await ctx.repos.users.putQuote(
    sub,
    {
      quoteId,
      purpose: input.purpose,
      labId,
      labVersion: lab.version,
      catalogVersion: release.catalogVersion,
      variant: v.variant,
      startProfile: v.profileName,
      startProfileDigest: await ctx.catalog.profileDigest(lab, v.variant, release.catalogVersion),
      region: config?.region ?? ctx.deps.env.region,
      ...priced,
      notes,
      costTier: lab.cost?.tier ?? null,
      durationMinutes,
      maxTotalMinutes,
      reuseEnvironmentId: plan?.environmentId ?? null,
      reusePlan: plan,
      issuedAt: ctx.nowIso,
      expiresAt: quoteExpiresAt(ctx.nowMs),
    },
    ctx.nowIso,
  );
  return quoteView(quote);
}

// ---------------------------------------------------------------------------------------------------------------
// POST /sessions

export interface CreateSessionInput {
  labId: string;
  quoteId: string;
  costAcknowledged?: boolean | undefined;
  variant?: string | undefined;
  trackId?: string | undefined;
  reuseEnvironmentId?: string | undefined;
  residualAck?: boolean | undefined;
  learnerInputs?: Record<string, string> | undefined;
  workstation?: 'ec2' | 'cloudshell' | undefined;
}

/** Quote checks of 02 §3.3 step 1 (ValidateQuote in the workflow repeats them authoritatively). */
export function checkQuote(
  quote: QuoteItem | null,
  want: { purposes: readonly QuotePurpose[]; labId?: string; variant?: string; labVersion?: string; catalogVersion?: string; reuseEnvironmentId?: string | null; sessionId?: string },
  nowMs: number,
): QuoteItem {
  if (!quote) throw new AtlError('QUOTE_EXPIRED', 'quote not found or expired; request a new quote');
  if (Date.parse(quote.expiresAt) <= nowMs) throw new AtlError('QUOTE_EXPIRED', `quote ${quote.quoteId} expired at ${quote.expiresAt}`);
  const mismatch = (what: string) => {
    throw new AtlError('QUOTE_MISMATCH', `quote ${quote.quoteId} does not match: ${what}`);
  };
  if (!want.purposes.includes(quote.purpose as QuotePurpose)) mismatch(`purpose ${quote.purpose}`);
  if (want.labId !== undefined && quote.labId !== want.labId) mismatch('labId');
  if (want.variant !== undefined && (quote.variant ?? DEFAULT_VARIANT) !== want.variant) mismatch('variant');
  if (want.labVersion !== undefined && quote.labVersion !== want.labVersion) mismatch('card version changed since the quote');
  if (want.catalogVersion !== undefined && quote.catalogVersion !== want.catalogVersion) mismatch('content release changed since the quote');
  if (want.reuseEnvironmentId !== undefined && (quote.reuseEnvironmentId ?? null) !== want.reuseEnvironmentId) mismatch('reuseEnvironmentId');
  if (want.sessionId !== undefined && quote.sessionId !== want.sessionId) mismatch('session');
  return quote;
}

export async function createSession(ctx: ServiceContext, principal: JwtPrincipal, actor: Actor, input: CreateSessionInput, requestId: string): Promise<SessionItem> {
  if (input.costAcknowledged !== true) throw new AtlError('COST_ACK_REQUIRED', 'costAcknowledged must be true');
  const release = await ctx.catalog.requireCurrent();
  const lab = await ctx.catalog.requireLab(input.labId, release.catalogVersion);
  const blockers: Blocker[] = [];
  if (lab.status === 'deprecated') blockers.push({ code: 'LAB_DEPRECATED', detail: `card ${lab.id} is deprecated and cannot start new sessions` });
  const v = resolveVariant(lab, input.variant);
  const reuseEnvId = input.reuseEnvironmentId ?? null;
  const quote = checkQuote(
    await ctx.repos.users.quote(principal.sub, input.quoteId),
    {
      purposes: reuseEnvId ? ['REUSE'] : ['START'],
      labId: lab.id,
      variant: v.variant,
      labVersion: lab.version,
      catalogVersion: release.catalogVersion,
      reuseEnvironmentId: reuseEnvId,
    },
    ctx.nowMs,
  );
  const missing = requiredLearnerInputs(lab).filter((id) => !input.learnerInputs?.[id]);
  if (missing.length) {
    throw new AtlError('VALIDATION_FAILED', `missing learner inputs: ${missing.join(', ')}`, { errors: missing.map((m) => ({ path: `learnerInputs.${m}`, message: 'required' })) });
  }
  if (input.workstation === 'cloudshell' && lab.workstation?.required) {
    throw new AtlError('VALIDATION_FAILED', `card ${lab.id} requires the EC2 workstation`, { errors: [{ path: 'workstation', message: 'cloudshell not allowed' }] });
  }
  const plan = quote.reusePlan as ReusePlan | null | undefined;
  if (reuseEnvId && plan && !plan.compatible) {
    blockers.push({ code: plan.reason === 'TARGET_ALREADY_SATISFIED' ? 'TARGET_ALREADY_SATISFIED' : 'VALIDATION_FAILED', detail: `environment ${reuseEnvId} cannot be reused (${plan.reason})` });
  }
  const st = await loadPlatformState(ctx.repos, ctx.nowMs);
  blockers.push(...startBlockers(st, { reuseEnvId, residualAck: !!input.residualAck, nowMs: ctx.nowMs }));
  if (blockers.length) throwBlocker(blockers[0]!);

  const sid = newSid();
  const digest = (quote.startProfileDigest as string | null | undefined) ?? (await ctx.catalog.profileDigest(lab, v.variant, release.catalogVersion));
  const draft: Record<string, unknown> = {
    sid,
    sub: principal.sub,
    labId: lab.id,
    labKind: lab.kind,
    variant: v.variant,
    trackId: input.trackId ?? null,
    catalogVersion: release.catalogVersion,
    labVersion: lab.version,
    platformVersion: (st.config?.version as string | undefined) ?? process.env.ATL_PLATFORM_VERSION ?? null,
    envId: reuseEnvId,
    reuseOfEnvId: reuseEnvId,
    startProfile: v.profileName,
    startProfileDigest: digest ?? 'sha256:unknown',
    startProfileResolved: null,
    targetModules: v.targetModules.map((t) => ({ id: t.id, from: t.fromDriver ?? null, to: t.driver })),
    cardFacts: cardFactsOf(lab, v),
    cardLimits: cardLimitsOf(lab),
    outageWindow: null,
    costQuote: {
      quoteId: quote.quoteId,
      purpose: quote.purpose,
      priceAsOf: quote.priceAsOf ?? null,
      currency: quote.currency ?? 'USD',
      hourly: quote.hourly ?? null,
      incomplete: quote.incomplete ?? [],
    },
    workstation: { mode: input.workstation ?? 'ec2', instanceId: null, stackName: null },
    residualAck: !!input.residualAck,
    learnerInputs: input.learnerInputs ?? {},
    preferredDisposition: null,
    requestedBy: { sub: principal.sub, username: principal.username, requestId },
  };
  const res = await ctx.lifecycle.createSession(draft, actor);
  const createdSid = typeof res?.sessionId === 'string' ? res.sessionId : sid;
  const created = await ctx.repos.sessions.get(createdSid, true);
  if (!created) throw new AtlError('INTERNAL', `atl-lifecycle CreateSession did not create session ${createdSid}`);
  const exec = await ctx.lifecycle.startSessionStart(createdSid);
  try {
    return await ctx.repos.sessions.updateDescriptive(createdSid, { startExecutionArn: exec.executionArn }, ['REQUESTED', 'PROVISIONING', 'READY', 'RUNNING', 'EXPIRING']);
  } catch {
    return (await ctx.repos.sessions.get(createdSid, true)) ?? created;
  }
}

/** “Current” session of a user: active ones first, then REQUESTED, KEPT, CLEANUP_FAILED (01 §8.2, 02 §13.1). */
export async function currentSession(ctx: ServiceContext, sub: string): Promise<SessionItem | null> {
  const list = await ctx.repos.sessions.listNonTerminalByUser(sub);
  const rank = (s: SessionItem) =>
    ['PROVISIONING', 'READY', 'RUNNING', 'EXPIRING', 'ENDING', 'CLEANING'].includes(s.state) ? 0 : s.state === 'REQUESTED' ? 1 : s.state === 'KEPT' ? 2 : 3;
  list.sort((a, b) => rank(a) - rank(b) || (a.createdAt < b.createdAt ? 1 : -1));
  return list[0] ?? null;
}
