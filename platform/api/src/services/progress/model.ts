/**
 * Pure progress functions (04 §8.2–§8.4, §8.8; tracks-and-catalog §5.2, §5.3): effective result, freshness, step state,
 * completion rules, evidence score and badge level. No I/O; table-driven tests in platform/api/test/progress-model.test.ts.
 */
import type { CheckSource } from '@atl/shared';
import type { CheckType, EffectiveResult } from '../../functions/checks/types.js';
import type { AttemptStatus, CheckState, MissingItem, StepState } from './types.js';

// ---------------------------------------------------------------------------------------------------------------
// 04 §8.2 effective result

export function effectiveResult(s: Pick<CheckState, 'lastAuto' | 'lastDecisive' | 'lastManual' | 'type'>): EffectiveResult {
  if (s.lastDecisive) return s.lastDecisive.result;
  const manual = s.lastManual && s.lastManual.review?.decision !== 'reject' ? s.lastManual : undefined;
  if (manual) return manual.result;
  const last = s.lastAuto?.result;
  if (last === 'pending' || last === 'error' || last === 'unavailable') return last;
  if (last === 'skipped') return 'skipped';
  if (s.type === 'manual') return 'needs_manual';
  return 'not_run';
}

/** Default freshness by source (04 §8.2): minutes; null = never stale. */
export const FRESHNESS_MINUTES: Readonly<Record<CheckSource, number | null>> = { LOCAL: 15, PROBE: 5, AWS: 30, EXP: null, MANUAL: null };
/** Re-test on entering a step after (minutes; 0 = always). */
export const RETEST_ON_ENTER_MINUTES: Readonly<Record<CheckSource, number | null>> = { LOCAL: 5, PROBE: 0, AWS: 10, EXP: null, MANUAL: null };

export function parseTtl(ttl: string | undefined): number | null {
  if (!ttl) return null;
  const m = /^(\d+)([smhd])$/.exec(ttl);
  if (!m) return null;
  const n = Number(m[1]);
  return m[2] === 's' ? n / 60 : m[2] === 'm' ? n : m[2] === 'h' ? n * 60 : n * 1440;
}

export function isStale(lastPassAt: string | undefined, source: CheckSource, nowMs: number, ttl?: string): boolean {
  if (!lastPassAt) return false;
  const minutes = parseTtl(ttl) ?? FRESHNESS_MINUTES[source];
  if (minutes === null) return false;
  return nowMs - Date.parse(lastPassAt) > minutes * 60_000;
}

// ---------------------------------------------------------------------------------------------------------------
// 04 §8.3 step state

export interface StepInput {
  whenFalse: boolean;
  skippedByLearner: boolean;
  requiredStepsDone: boolean;
  runtimeReqsMet: boolean;
  requiredChecks: EffectiveResult[];
  firstPassedAt: string | null | undefined;
  /** A required must-hold check that once passed now fails. */
  hasMustHoldFailure: boolean;
  running: boolean;
  /** Reading-type step marked as read (`POST …/steps/{stepId}/read`); only used when the step has no required checks. */
  read?: boolean;
}

export function stepState(s: StepInput): StepState {
  if (s.whenFalse || s.skippedByLearner) return 'skipped';
  if (!s.requiredStepsDone || !s.runtimeReqsMet) return 'locked';
  if (s.requiredChecks.length === 0) return s.read ? 'done' : 'available';
  // checks skipped by `when` / `dependsOn` are not in the denominator (same rule as skipped steps)
  const eff = s.requiredChecks.filter((r) => r !== 'skipped');
  const achieved = s.firstPassedAt != null;
  if (eff.some((r) => r === 'fail')) return achieved && s.hasMustHoldFailure ? 'drifted' : 'failed';
  if (s.running || eff.some((r) => r === 'pending')) return 'verifying';
  if (eff.some((r) => r === 'error')) return 'error';
  if (eff.some((r) => r === 'unavailable' || r === 'needs_manual')) return 'needs_manual';
  if (eff.every((r) => r === 'pass')) return 'done';
  if (eff.every((r) => r === 'pass' || r === 'manual' || r === 'manual_evidence')) return 'done_manual';
  return 'available';
}

export function isAchieved(state: StepState): boolean {
  return state === 'done' || state === 'done_manual' || state === 'drifted';
}

// ---------------------------------------------------------------------------------------------------------------
// 04 §8.4 completion rules

export interface CompletionStep {
  stepId: string;
  required: boolean;
  state: StepState;
}

export interface CompletionCheck {
  stepId: string | null;
  checkKey: string;
  required: boolean;
  type: CheckType;
  mustHold: boolean;
  /** Effective result after the final re-test. */
  effective: EffectiveResult;
  errorCode?: string | null;
  manualKind?: 'native' | 'degraded';
}

export interface CompletionExperiment {
  module: string;
  experiment: string;
  required: boolean;
  satisfied: boolean;
  pendingCrosscheck: boolean;
  reason?: string;
}

export interface CompletionInput {
  steps: CompletionStep[];
  checks: CompletionCheck[];
  finalChecks: CompletionCheck[];
  experiments: CompletionExperiment[];
}

export interface CompletionVerdict {
  complete: boolean;
  withManual: boolean;
  missing: MissingItem[];
  /** Only missing ownership confirmations (→ `unverified` at finalization, 04 §8.5). */
  onlyOwnershipPending: boolean;
  ownershipPending: string[];
  pendingCrosscheck: boolean;
}

const MANUAL_RESULTS: readonly EffectiveResult[] = ['manual', 'manual_evidence'];

function checkSatisfied(c: CompletionCheck): boolean {
  if (c.effective === 'pass' || c.effective === 'skipped') return true;
  if (MANUAL_RESULTS.includes(c.effective)) {
    // manual only satisfies native manual checks and the degraded form of aws-readonly (04 §8.8)
    return c.type === 'manual' || (c.type === 'aws-readonly' && c.manualKind === 'degraded');
  }
  return false;
}

export function evaluateCompletion(input: CompletionInput): CompletionVerdict {
  const missing: MissingItem[] = [];
  const ownershipPending: string[] = [];
  let withManual = false;
  for (const s of input.steps) {
    if (!s.required || s.state === 'skipped') continue;
    if (s.state !== 'done' && s.state !== 'done_manual') missing.push({ stepId: s.stepId, checkKey: '', result: 'step', reason: `step ${s.state}` });
    if (s.state === 'done_manual') withManual = true;
  }
  for (const c of [...input.checks, ...input.finalChecks]) {
    if (!c.required) continue;
    if (!c.mustHold && c.stepId !== null) continue; // `once` checks are covered by the step state
    if (checkSatisfied(c)) {
      if (MANUAL_RESULTS.includes(c.effective)) withManual = true;
      continue;
    }
    if (c.errorCode === 'OWNERSHIP_PENDING') ownershipPending.push(c.checkKey);
    missing.push({ stepId: c.stepId, checkKey: c.checkKey, result: c.effective, ...(c.errorCode ? { errorCode: c.errorCode as MissingItem['errorCode'] } : {}) });
  }
  let pendingCrosscheck = false;
  for (const e of input.experiments) {
    if (!e.required) continue;
    if (e.pendingCrosscheck) pendingCrosscheck = true;
    if (!e.satisfied) missing.push({ stepId: null, checkKey: `${e.module}/${e.experiment}`, result: 'fail', reason: e.reason ?? 'experiment not satisfied' });
  }
  // step-level gaps caused only by the same pending ownership do not count separately
  const nonOwnership = missing.filter((m) => !(m.errorCode === 'OWNERSHIP_PENDING' || (m.result === 'step' && ownershipPending.length > 0 && stepOnlyPendingOwnership(m.stepId, input))));
  return {
    complete: missing.length === 0,
    withManual,
    missing,
    onlyOwnershipPending: missing.length > 0 && nonOwnership.length === 0,
    ownershipPending,
    pendingCrosscheck,
  };
}

function stepOnlyPendingOwnership(stepId: string | null, input: CompletionInput): boolean {
  const checks = input.checks.filter((c) => c.stepId === stepId && c.required);
  const bad = checks.filter((c) => !checkSatisfied(c));
  return bad.length > 0 && bad.every((c) => c.errorCode === 'OWNERSHIP_PENDING');
}

/** Attempt status after a final review (04 §8.4): only upgrades once completed. */
export function nextAttemptStatus(current: AttemptStatus, verdict: CompletionVerdict, mode: 'submit' | 'finalize' | 'late-ownership', timedOut = false): AttemptStatus {
  if (current === 'completed' || current === 'void') return current;
  const success: AttemptStatus = verdict.withManual ? 'completed_manual' : 'completed';
  if (verdict.complete) return current === 'completed_manual' && success === 'completed_manual' ? 'completed_manual' : success;
  if (current === 'completed_manual') return current;
  if (mode === 'submit') return 'active';
  if (mode === 'late-ownership') return current;
  if (timedOut || verdict.onlyOwnershipPending) return 'unverified';
  return 'incomplete';
}

// ---------------------------------------------------------------------------------------------------------------
// Evidence score and badge level (tracks-and-catalog §5.3; 04 §8.8)

export interface ScoredCheck {
  effective: EffectiveResult;
  type: CheckType;
  manualKind?: 'native' | 'degraded';
  reviewed?: boolean;
  /** Experiment validity when the check is an experiment check. */
  simulated?: boolean;
}

export function checkWeight(c: ScoredCheck): number {
  if (c.effective === 'pass') return c.type === 'experiment' && c.simulated ? 0.8 : 1.0;
  if (c.effective === 'manual_evidence') return 0.9;
  if (c.effective === 'manual') {
    if (c.type === 'manual' || c.manualKind === 'native') return 1.0;
    return c.reviewed ? 0.8 : 0.5;
  }
  return 0;
}

/** E = mean weight of the required checks (skipped ones excluded). */
export function evidenceScore(checks: ScoredCheck[]): number {
  const counted = checks.filter((c) => c.effective !== 'skipped');
  if (counted.length === 0) return 1;
  const sum = counted.reduce((a, c) => a + checkWeight(c), 0);
  return Math.round((sum / counted.length) * 1000) / 1000;
}

export function badgeLevel(e: number): 'verified' | 'attested' | 'self-reported' {
  return e >= 0.95 ? 'verified' : e >= 0.8 ? 'attested' : 'self-reported';
}

const LEVEL_RANK = { 'self-reported': 0, attested: 1, verified: 2 } as const;
export function betterLevel(a: keyof typeof LEVEL_RANK, b: keyof typeof LEVEL_RANK): keyof typeof LEVEL_RANK {
  return LEVEL_RANK[a] >= LEVEL_RANK[b] ? a : b;
}

const STATUS_RANK = { not_started: 0, attempted: 1, completed_manual: 2, completed: 3 } as const;
export function betterProgressStatus(a: keyof typeof STATUS_RANK, b: keyof typeof STATUS_RANK): keyof typeof STATUS_RANK {
  return STATUS_RANK[a] >= STATUS_RANK[b] ? a : b;
}
