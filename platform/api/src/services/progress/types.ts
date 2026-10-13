/**
 * Progress entities written by atl-checks (04 §8; 01 §7.3): StepResult, LabAttempt, LabProgress. Field names follow 01
 * §7.3 and 04 §8.6; anything new is listed in implementation-notes “platform-checks”.
 */
import type { CheckErrorCode, CheckResultValue, EffectiveResult, Provenance } from '../../functions/checks/types.js';

export const STEP_STATES = ['locked', 'available', 'verifying', 'failed', 'error', 'needs_manual', 'done', 'done_manual', 'drifted', 'skipped'] as const;
export type StepState = (typeof STEP_STATES)[number];
/** States that count as achieved (04 §8.3 table). */
export const ACHIEVED_STEP_STATES: readonly StepState[] = ['done', 'done_manual', 'drifted'];

export const ATTEMPT_STATUSES = ['active', 'verifying', 'completed', 'completed_manual', 'incomplete', 'unverified', 'void'] as const;
export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number];
export const FINAL_ATTEMPT_STATUSES: readonly AttemptStatus[] = ['completed', 'completed_manual', 'incomplete', 'unverified', 'void'];

export type DriftClass = 'config' | 'runtime' | 'behavior' | 'ownership';

export interface DriftEvent {
  checkId: string;
  checkKey: string;
  kind: DriftClass;
  at: string;
  runId: string;
  fromRunId?: string;
}

export interface ManualRecord {
  confirmationId: string;
  kind: 'native' | 'degraded';
  result: 'manual' | 'manual_evidence';
  observed: string;
  note: string;
  at: string;
  by: string;
  review?: { by: string; decision: 'approve' | 'reject'; comment?: string; at: string };
}

export interface CheckState {
  checkKey: string;
  required: boolean;
  /** Effective result (04 §8.2), recomputed on every write. */
  effective: EffectiveResult;
  lastAuto?: { result: CheckResultValue; at: string; runId: string; errorCode?: CheckErrorCode | null; evidenceDigest?: string };
  /** Latest automatic pass / fail — `error`, `unavailable`, `pending` never override it (04 §8.2). */
  lastDecisive?: { result: 'pass' | 'fail'; at: string; runId: string; errorCode?: CheckErrorCode | null };
  type?: string;
  lastPass?: { at: string; runId: string; evidenceDigest: string; instanceIds?: string[]; provenance?: Provenance; resource?: string };
  firstPassAt?: string;
  lastManual?: ManualRecord;
  /** Evidence of the latest pass (small; used for `{{$check.<id>.…}}`). */
  passEvidence?: unknown;
  stale?: boolean;
  drift?: { policy: 'must-hold' | 'once'; monitor?: boolean };
  ownershipPending?: boolean;
  /** Experiment check satisfied by a simulated baseline / a run still in cross-check. */
  simulated?: boolean;
  pendingCrosscheck?: boolean;
}

export interface StepResultItem {
  type: 'StepResult';
  sessionId: string;
  stepId: string;
  moduleId?: string | null;
  state: StepState;
  checks: Record<string, CheckState>;
  firstPassedAt?: string | null;
  lastPassedAt?: string | null;
  firstViewedAt?: string | null;
  startedAt?: string | null;
  driftEvents: DriftEvent[];
  driftAcks: { at: string; by: string; checkIds: string[] }[];
  skipped: boolean;
  provenance?: Provenance | null;
  flags: string[];
  ver: number;
  createdAt: string;
  updatedAt: string;
}

export interface MissingItem {
  stepId: string | null;
  checkKey: string;
  result: EffectiveResult | 'step';
  errorCode?: CheckErrorCode | null;
  reason?: string;
}

export interface LabAttemptItem {
  type: 'LabAttempt';
  sessionId: string;
  sub: string;
  labId: string;
  labKind: 'service' | 'scenario';
  status: AttemptStatus;
  labVersion: string;
  catalogVersion: string;
  contentDigest: string;
  variant: string;
  variables: Record<string, string>;
  quoteId?: string | null;
  submittedAt?: string | null;
  completedAt?: string | null;
  ownershipPending: string[];
  /** Ownership lookups already requested, by resource ARN (rhythm 2, 2, 4, 4, 8 min; 01 §3.12). */
  ownershipLookups?: Record<string, { first: string; count: number; nextAt: string }>;
  missing?: MissingItem[];
  finalize?: { at: string; checkRunId: string | null; attemptStatus: AttemptStatus; reportRevision: number | null; certificateEligible: boolean; notes: string[] } | null;
  lastExpiringPrecheckAt?: string | null;
  lastDriftPatrolAt?: string | null;
  /** Counted automatic vs manual satisfactions at completion (reports / certificates). */
  checksSummary?: { auto: number; manual: number; failed: number } | null;
  evidenceScore?: number | null;
  ownershipConfirmedLate?: boolean;
  ver: number;
  createdAt: string;
  updatedAt: string;
}

export interface BadgeRecord {
  level: 'verified' | 'attested' | 'self-reported';
  status: 'valid' | 'pending' | 'withdrawn';
  earnedAt: string;
  attemptId: string;
  labVersion: string;
  variant: string;
  evidenceScore: number;
  quiz?: { bestScore: number; byDomain: Record<string, number>; attempts: number };
  withdrawnAt?: string;
  withdrawnReason?: string;
}

export interface LabProgressItem {
  type: 'LabProgress';
  sub: string;
  labId: string;
  kind: 'service' | 'scenario';
  status: 'not_started' | 'attempted' | 'completed' | 'completed_manual';
  bestAttemptId: string | null;
  attempts: number;
  attemptIds: string[];
  firstCompletedAt: string | null;
  badge: BadgeRecord | null;
  credits: { serviceId: string; attemptId: string; provenance: Provenance }[];
  regressions: { serviceId: string; foundInSession: string; checkKey: string; at: string }[];
  quizByService: Record<string, number>;
  ver: number;
  createdAt: string;
  updatedAt: string;
}
