/**
 * Errors raised by the lifecycle functions. The error `name` is what Step Functions sees as the error (`Atl.*`, 02 §4.4)
 * and what a synchronous `lambda:InvokeFunction` caller (atl-api) receives as `errorType`. `LIFECYCLE_ERROR_CODES` maps
 * the names that atl-api must turn into problem+json (01 §8.6) — the only contract between the two functions besides the
 * action payloads documented in docs/implementation-notes.md (platform-lifecycle).
 */
import type { ErrorCode, FailureCode } from '@atl/shared';

export class WorkflowError extends Error {
  /** Failure code for `LabSession.failure.code` (02 §13.2) when the error ends a start. */
  readonly failureCode: FailureCode | null;
  readonly details: Record<string, unknown>;
  constructor(name: string, message: string, opts: { failureCode?: FailureCode | null; details?: Record<string, unknown> } = {}) {
    super(message);
    this.name = name.startsWith('Atl.') ? name : `Atl.${name}`;
    this.failureCode = opts.failureCode ?? null;
    this.details = opts.details ?? {};
  }
}

export const err = {
  retryable: (msg: string) => new WorkflowError('Atl.Retryable', msg),
  transitionRejected: (msg: string) => new WorkflowError('Atl.TransitionRejected', msg),
  alreadyTerminal: (msg: string) => new WorkflowError('Atl.AlreadyTerminal', msg),
  notFound: (msg: string) => new WorkflowError('Atl.NotFound', msg),
  invalid: (msg: string) => new WorkflowError('Atl.InvalidInput', msg),
} as const;

/** `Atl.*` error name → API error code (01 §8.6) for the synchronous API actions. */
export const LIFECYCLE_ERROR_CODES: Readonly<Record<string, ErrorCode>> = {
  'Atl.NotFound': 'NOT_FOUND',
  'Atl.InvalidInput': 'VALIDATION_FAILED',
  'Atl.TransitionRejected': 'INVALID_STATE',
  'Atl.AlreadyTerminal': 'INVALID_STATE',
  'Atl.CostNotAcknowledged': 'COST_ACK_REQUIRED',
  'Atl.QuoteExpired': 'QUOTE_EXPIRED',
  'Atl.QuoteMismatch': 'QUOTE_MISMATCH',
  'Atl.VariantUnknown': 'VARIANT_UNKNOWN',
  'Atl.SessionActiveExists': 'SESSION_ACTIVE_EXISTS',
  'Atl.EnvKeptExists': 'ENV_KEPT_EXISTS',
  'Atl.CleanupInProgress': 'CLEANUP_IN_PROGRESS',
  'Atl.ResidualAckRequired': 'RESIDUAL_ACK_REQUIRED',
  'Atl.BudgetBlocked': 'BUDGET_BLOCKED',
  'Atl.PlatformUninstalling': 'PLATFORM_UNINSTALLING',
  'Atl.MaintenanceMode': 'MAINTENANCE_MODE',
  'Atl.ReuseInProgress': 'REUSE_IN_PROGRESS',
  'Atl.SessionExpiringOrEnded': 'SESSION_EXPIRING_OR_ENDED',
  'Atl.ExtensionLimit': 'EXTENSION_LIMIT',
  'Atl.PreconditionFailed': 'PRECONDITION_FAILED',
  'Atl.KeepNotAllowed': 'KEEP_NOT_ALLOWED',
  'Atl.LimitExceeded': 'LIMIT_EXCEEDED',
  'Atl.OpNotAllowed': 'OP_NOT_ALLOWED',
  'Atl.SessionNotRunning': 'INVALID_STATE',
  'Atl.Throttled': 'UPSTREAM_THROTTLED',
  'Atl.Unavailable': 'UPSTREAM_UNAVAILABLE',
};

/** Lock / start refusals of `AcquireLock` share one Step Functions error name (`Atl.LockBusy`) plus a detail code. */
export function lockBusy(code: 'SESSION_ACTIVE_EXISTS' | 'ENV_KEPT_EXISTS' | 'CLEANUP_IN_PROGRESS', message: string, details: Record<string, unknown> = {}) {
  return new WorkflowError('Atl.LockBusy', `${code}: ${message}`, { failureCode: 'LOCK_BUSY', details: { code, ...details } });
}

/** Name of an error thrown by another function (synchronous invoke) or a port. */
export function nameOf(e: unknown): string {
  return e && typeof e === 'object' && 'name' in e ? String((e as { name: unknown }).name) : '';
}

export function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
