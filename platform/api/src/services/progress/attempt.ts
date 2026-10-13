/**
 * LabAttempt and LabProgress (04 §8.4–§8.6; tracks-and-catalog §5.2–§5.4): attempt creation at READY, completion
 * verdicts of a final review, “only upgrade” transitions, badges with evidence score and level, service credits.
 */
import { Keys } from '../../data/keys.js';
import { FINAL_STEP, type PlannedCheck, type SessionFacts } from '../../functions/checks/engine/facts.js';
import { experimentVerdict, type ExperimentRunRecord } from '../../functions/checks/engine/experiments.js';
import type { Provenance } from '../../functions/checks/types.js';
import type { PendingEvent } from './events.js';
import { effectiveWithPolicy } from './evaluator.js';
import { badgeLevel, betterLevel, betterProgressStatus, evaluateCompletion, evidenceScore, isAchieved, nextAttemptStatus, type CompletionCheck, type CompletionVerdict, type ScoredCheck } from './model.js';
import { mutate, type ItemStore } from './store.js';
import type { AttemptStatus, BadgeRecord, LabAttemptItem, LabProgressItem, StepResultItem } from './types.js';

export function newAttempt(facts: SessionFacts, nowIso: string): LabAttemptItem {
  const s = facts.session;
  return {
    type: 'LabAttempt',
    sessionId: s.sid,
    sub: s.sub,
    labId: s.labId,
    labKind: s.labKind ?? (s.labId.startsWith('svc-') ? 'service' : 'scenario'),
    status: 'active',
    labVersion: facts.card.lab.version,
    catalogVersion: s.catalogVersion,
    contentDigest: facts.card.contentDigest ?? 'unknown',
    variant: s.variant ?? 'default',
    variables: {},
    quoteId: (s.costQuote as { quoteId?: string } | null | undefined)?.quoteId ?? null,
    ownershipPending: [],
    ver: 0,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
}

/** Create the attempt when the session is READY (idempotent); `void` when the session ended before READY. */
export async function ensureAttempt(store: ItemStore, facts: SessionFacts, nowIso: string, status: AttemptStatus = 'active'): Promise<LabAttemptItem> {
  const r = await mutate<LabAttemptItem>(store, Keys.labAttempt(facts.session.sid), (cur) => (cur ? null : ({ ...newAttempt(facts, nowIso), status } as LabAttemptItem & Record<string, unknown>)), { now: () => nowIso });
  return r!;
}

export interface ReviewInput {
  facts: SessionFacts;
  plan: PlannedCheck[];
  steps: Map<string, StepResultItem>;
  runs: ExperimentRunRecord[];
}

/** Build the completion input from stored step results (after the final re-test was folded in). */
export function completionOf(i: ReviewInput, stepStates: Map<string, string>): CompletionVerdict {
  const lab = i.facts.card.lab;
  const steps = lab.steps.map((st) => ({
    stepId: st.id,
    required: !(st.optional === true || (typeof st.optional === 'object' && st.optional !== null)),
    state: (stepStates.get(st.id) ?? i.steps.get(st.id)?.state ?? 'available') as never,
  }));
  const toCheck = (p: PlannedCheck): CompletionCheck => {
    const c = i.steps.get(p.stepId ?? '')?.checks?.[p.localId];
    return {
      stepId: p.stepId === FINAL_STEP ? null : p.stepId,
      checkKey: p.checkKey,
      required: p.required,
      type: p.decl.type,
      mustHold: p.drift.policy === 'must-hold',
      effective: c ? effectiveWithPolicy(c, p.drift.policy === 'once') : p.decl.type === 'manual' ? 'needs_manual' : 'not_run',
      errorCode: c?.lastAuto?.errorCode ?? null,
      ...(c?.lastManual ? { manualKind: c.lastManual.kind } : {}),
    };
  };
  const stepRequired = new Map(steps.map((s) => [s.stepId, s.required]));
  const checks = i.plan.filter((p) => p.stepId !== FINAL_STEP && p.stepId !== null && stepRequired.get(p.stepId) !== false && i.steps.get(p.stepId)?.state !== 'skipped').map(toCheck);
  const finals = i.plan.filter((p) => p.stepId === FINAL_STEP).map(toCheck);
  const experiments = (lab.experiments ?? []).map((e) => {
    const v = experimentVerdict(e, i.runs);
    return { module: e.module, experiment: e.id, required: e.required, satisfied: v.ok, pendingCrosscheck: v.pendingCrosscheck, reason: v.reasons.filter((r) => !r.ok).map((r) => r.label).join('; ') };
  });
  return evaluateCompletion({ steps, checks, finalChecks: finals, experiments });
}

/** Evidence score inputs: required checks of required, non-skipped steps plus finalChecks (tracks §5.3). */
export function scoredChecks(i: ReviewInput): ScoredCheck[] {
  const out: ScoredCheck[] = [];
  const lab = i.facts.card.lab;
  const optionalSteps = new Set(lab.steps.filter((s) => s.optional === true || (typeof s.optional === 'object' && s.optional !== null)).map((s) => s.id));
  for (const p of i.plan) {
    if (!p.required || (p.stepId && optionalSteps.has(p.stepId))) continue;
    const st = i.steps.get(p.stepId ?? '');
    if (st?.state === 'skipped') continue;
    const c = st?.checks?.[p.localId];
    const eff = c ? effectiveWithPolicy(c, p.drift.policy === 'once') : 'not_run';
    out.push({
      effective: eff,
      type: p.decl.type,
      ...(c?.lastManual ? { manualKind: c.lastManual.kind, reviewed: c.lastManual.review?.decision === 'approve' } : {}),
      ...(c?.simulated ? { simulated: true } : {}),
    });
  }
  return out;
}

export function countChecks(scored: ScoredCheck[]): { auto: number; manual: number; failed: number } {
  let auto = 0;
  let manual = 0;
  let failed = 0;
  for (const c of scored) {
    if (c.effective === 'pass') auto++;
    else if (c.effective === 'manual' || c.effective === 'manual_evidence') manual++;
    else if (c.effective !== 'skipped') failed++;
  }
  return { auto, manual, failed };
}

/** Wire evidence of every non-optional target must come from this session (badge condition 2, tracks §5.2). */
export function wireProvenanceOk(i: ReviewInput): boolean {
  const lab = i.facts.card.lab;
  for (const t of lab.targetModules.filter((t) => !t.optional)) {
    const st = i.steps.get(t.wireStep);
    if (!st || !isAchieved(st.state)) return false;
    const provs = Object.values(st.checks ?? {})
      .filter((c) => c.required && c.lastPass)
      .map((c) => c.lastPass!.provenance ?? 'this-session');
    const sameCardChain = i.facts.chain.filter((c) => c.sub === i.facts.session.sub && c.labId === lab.id).map((c) => `inherited:${c.sid}`);
    if (provs.some((p) => p !== 'this-session' && !sameCardChain.includes(p))) return false;
  }
  return true;
}

/** Service credits (tracks §5.4): targets' services through their wire step, plus `creditBy` steps. */
export function creditsOf(i: ReviewInput, attemptId: string): { serviceId: string; attemptId: string; provenance: Provenance }[] {
  const lab = i.facts.card.lab;
  const out: { serviceId: string; attemptId: string; provenance: Provenance }[] = [];
  const targets = new Map(lab.targetModules.map((t) => [t.id, t.wireStep]));
  for (const svc of lab.services) {
    if (svc.role === 'observed') continue;
    const steps = svc.creditBy ?? (svc.module && targets.has(svc.module) && svc.role !== 'context' ? [targets.get(svc.module)!] : []);
    if (!steps.length) continue;
    const ok = steps.every((id) => {
      const st = i.steps.get(id);
      return !!st && isAchieved(st.state) && Object.values(st.checks ?? {}).every((c) => !c.lastPass || (c.lastPass.provenance ?? 'this-session') === 'this-session');
    });
    if (ok) out.push({ serviceId: svc.id, attemptId, provenance: 'this-session' });
  }
  return out;
}

export interface FinalizeOutcome {
  attempt: LabAttemptItem;
  events: PendingEvent[];
  badge: BadgeRecord | null;
  verdict: CompletionVerdict;
}

/** Apply a final-review verdict to the attempt and (on first completion) the learner's LabProgress and badge. */
export async function applyReview(
  store: ItemStore,
  i: ReviewInput,
  stepStates: Map<string, string>,
  opts: { mode: 'submit' | 'finalize' | 'late-ownership'; nowIso: string; checkRunId: string | null; timedOut?: boolean },
): Promise<FinalizeOutcome> {
  const verdict = completionOf(i, stepStates);
  const scored = scoredChecks(i);
  const e = evidenceScore(scored);
  const counts = countChecks(scored);
  const events: PendingEvent[] = [];
  const sid = i.facts.session.sid;
  let fromStatus: AttemptStatus = 'active';
  const attempt = await mutate<LabAttemptItem>(
    store,
    Keys.labAttempt(sid),
    (cur) => {
      const a: LabAttemptItem = cur ? { ...cur } : newAttempt(i.facts, opts.nowIso);
      fromStatus = a.status;
      const to = nextAttemptStatus(a.status === 'verifying' ? 'active' : a.status, verdict, opts.mode, opts.timedOut);
      a.status = to;
      a.missing = verdict.missing;
      a.ownershipPending = verdict.ownershipPending;
      if (opts.mode === 'submit') a.submittedAt = opts.nowIso;
      if ((to === 'completed' || to === 'completed_manual') && !a.completedAt) a.completedAt = opts.nowIso;
      if (to === 'completed' || to === 'completed_manual') {
        a.checksSummary = counts;
        a.evidenceScore = e;
        if (opts.mode === 'late-ownership') a.ownershipConfirmedLate = true;
      }
      return a as LabAttemptItem & Record<string, unknown>;
    },
    { now: () => opts.nowIso },
  );
  const a = attempt!;
  if (fromStatus !== a.status) events.push({ type: 'attempt.state_changed', sessionId: sid, data: { from: fromStatus, to: a.status, missing: verdict.missing.length } });
  let badge: BadgeRecord | null = null;
  const completed = a.status === 'completed' || a.status === 'completed_manual';
  const badgeOk = completed && wireProvenanceOk(i);
  const lp = await mutate<LabProgressItem>(
    store,
    Keys.labProgress(i.facts.session.sub, i.facts.session.labId),
    (cur) => {
      const p: LabProgressItem = cur
        ? { ...cur }
        : {
            type: 'LabProgress',
            sub: i.facts.session.sub,
            labId: i.facts.session.labId,
            kind: a.labKind,
            status: 'not_started',
            bestAttemptId: null,
            attempts: 0,
            attemptIds: [],
            firstCompletedAt: null,
            badge: null,
            credits: [],
            regressions: [],
            quizByService: {},
            ver: 0,
            createdAt: opts.nowIso,
            updatedAt: opts.nowIso,
          };
      if (!p.attemptIds.includes(sid) && a.status !== 'void') {
        p.attemptIds = [...p.attemptIds, sid];
        p.attempts = p.attemptIds.length;
      }
      const status = completed ? (a.status as 'completed' | 'completed_manual') : 'attempted';
      const better = betterProgressStatus(p.status, status);
      if (better !== p.status) {
        p.status = better;
        p.bestAttemptId = sid;
      } else if (!p.bestAttemptId) p.bestAttemptId = sid;
      if (completed && !p.firstCompletedAt) p.firstCompletedAt = a.completedAt ?? opts.nowIso;
      if (badgeOk) {
        const level = badgeLevel(e);
        const status2: BadgeRecord['status'] = verdict.pendingCrosscheck ? 'pending' : 'valid';
        if (!p.badge || p.badge.status === 'withdrawn') {
          badge = { level, status: status2, earnedAt: opts.nowIso, attemptId: sid, labVersion: a.labVersion, variant: a.variant, evidenceScore: e, ...(p.badge?.quiz ? { quiz: p.badge.quiz } : {}) };
          p.badge = badge;
        } else if (betterLevel(p.badge.level, level) !== p.badge.level || (p.badge.status === 'pending' && status2 === 'valid' && p.badge.attemptId === sid)) {
          badge = { ...p.badge, level: betterLevel(p.badge.level, level), status: p.badge.status === 'pending' ? status2 : p.badge.status, attemptId: sid, evidenceScore: Math.max(e, p.badge.evidenceScore), labVersion: a.labVersion, variant: a.variant };
          p.badge = badge;
        }
        const credits = creditsOf(i, sid);
        const known = new Set(p.credits.map((c) => c.serviceId));
        p.credits = [...p.credits, ...credits.filter((c) => !known.has(c.serviceId))];
      }
      return p as LabProgressItem & Record<string, unknown>;
    },
    { now: () => opts.nowIso },
  );
  if (badge && lp) events.push({ type: 'badge.earned', sessionId: sid, data: { sub: i.facts.session.sub, labId: i.facts.session.labId, level: (badge as BadgeRecord).level, status: (badge as BadgeRecord).status } });
  return { attempt: a, events, badge, verdict };
}

/** Badge withdrawal when the evidence of the completing attempt became invalid (04 §8.6, tracks §5.6). */
export async function withdrawBadge(store: ItemStore, sub: string, labId: string, attemptId: string, reason: string, nowIso: string): Promise<boolean> {
  let withdrawn = false;
  await mutate<LabProgressItem>(
    store,
    Keys.labProgress(sub, labId),
    (cur) => {
      if (!cur?.badge || cur.badge.attemptId !== attemptId || cur.badge.status === 'withdrawn') return null;
      withdrawn = true;
      return { ...cur, badge: { ...cur.badge, status: 'withdrawn', withdrawnAt: nowIso, withdrawnReason: reason } } as LabProgressItem & Record<string, unknown>;
    },
    { now: () => nowIso },
  );
  return withdrawn;
}
