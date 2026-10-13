/**
 * `LabSession.failure = { code, phase, message, diagnostics[] }` (02 §2.6) from a Step Functions error object
 * `{ Error, Cause }`. Lifecycle errors carry their failure code as the message prefix (`QUOTE_EXPIRED: …`); the start
 * workflow's Pass states put the code in `Cause` directly.
 */
import { FAILURE_CODES, type FailureCode, type LabSessionFailure } from '@atl/shared';
import type { SessionRecord } from './store/model.js';

const CODES = new Set<string>(FAILURE_CODES);

export interface SfnError {
  Error?: string;
  Cause?: string;
}

const BY_ERROR: Record<string, FailureCode> = {
  'Atl.QuoteExpired': 'QUOTE_EXPIRED',
  'Atl.QuoteMismatch': 'QUOTE_MISMATCH',
  'Atl.CostNotAcknowledged': 'QUOTE_MISMATCH',
  'Atl.VariantUnknown': 'VARIANT_UNKNOWN',
  'Atl.LockBusy': 'LOCK_BUSY',
  'Atl.ResidualAckRequired': 'LOCK_BUSY',
  'Atl.BudgetBlocked': 'LOCK_BUSY',
  'Atl.PlatformUninstalling': 'LOCK_BUSY',
  'Atl.ReservationLost': 'ENV_NOT_AVAILABLE',
  'Atl.PreflightFailed': 'PREFLIGHT_PREREQ',
  'Atl.BaseDeployFailed': 'BASE_DEPLOY_FAILED',
  'Atl.ProfileApplyFailed': 'PROFILE_STACK_FAILED',
  'Atl.ExtraStackFailed': 'EXTRA_STACK_FAILED',
  'Atl.WorkstationFailed': 'WORKSTATION_FAILED',
  'Atl.SsmNotRegistered': 'SSM_NOT_REGISTERED',
  'Atl.HealthFailed': 'HEALTH_FAILED',
  'Atl.HealthNotReady': 'HEALTH_FAILED',
  'States.Timeout': 'PROVISION_TIMEOUT',
};

export function isFailureCode(v: unknown): v is FailureCode {
  return typeof v === 'string' && CODES.has(v);
}

/** Leading `CODE:` of a message, or the whole message when it is a code. */
export function codeInMessage(msg: string | null | undefined): FailureCode | null {
  if (!msg) return null;
  const t = msg.trim();
  if (isFailureCode(t)) return t;
  const m = /^([A-Z][A-Z0-9_]+):/.exec(t);
  return m && isFailureCode(m[1]) ? m[1] : null;
}

/** A Lambda task failure's `Cause` is the JSON `{ errorType, errorMessage, … }` on AWS; plain text in the simulator. */
export function causeMessage(cause: string | null | undefined): string {
  if (!cause) return '';
  try {
    const parsed = JSON.parse(cause) as { errorMessage?: unknown };
    if (typeof parsed?.errorMessage === 'string') return parsed.errorMessage;
  } catch {
    // plain text
  }
  return cause;
}

export function failureCodeOf(e: SfnError | null | undefined, fallback: FailureCode = 'WORKFLOW_ERROR'): FailureCode {
  if (!e) return fallback;
  return codeInMessage(causeMessage(e.Cause)) ?? (e.Error ? BY_ERROR[e.Error] : undefined) ?? fallback;
}

/** Current RUNNING phase of the session (where the failure happened). */
export function currentPhase(s: Pick<SessionRecord, 'phases' | 'state'>): string {
  const running = [...(s.phases ?? [])].reverse().find((p) => p.status === 'RUNNING' || p.status === 'RETRYING');
  return running?.name ?? s.state.toLowerCase();
}

export function buildFailure(s: Pick<SessionRecord, 'phases' | 'state'>, e: SfnError | null | undefined, fallback: FailureCode = 'WORKFLOW_ERROR'): LabSessionFailure {
  const code = failureCodeOf(e, fallback);
  const cause = e?.Cause ?? '';
  let message = cause;
  try {
    const parsed = JSON.parse(cause) as { errorMessage?: string; Build?: { BuildStatus?: string } };
    if (parsed.errorMessage) message = parsed.errorMessage;
    else if (parsed.Build) message = `runner build ${parsed.Build.BuildStatus ?? 'failed'}`;
  } catch {
    // plain text cause
  }
  return { code, phase: currentPhase(s), message: (message || e?.Error || code).slice(0, 2000), diagnostics: e?.Error ? [{ error: e.Error }] : [] };
}
