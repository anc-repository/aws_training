/**
 * Errors raised by port implementations. Production adapters translate AWS SDK errors into these codes so that platform
 * logic (and the in-process simulator) never depend on SDK error classes.
 */
export type PortErrorCode =
  | 'ExecutionAlreadyExists' // states:StartExecution with a used name (02 §2.7)
  | 'ExecutionDoesNotExist'
  | 'ScheduleConflict' // scheduler:CreateSchedule on an existing name; callers treat it as success (02 §2.7)
  | 'NotFound'
  | 'Throttled'
  | 'AccessDenied'
  | 'Unavailable'
  | 'InvalidInput'
  | 'NotImplemented';

export class PortError extends Error {
  readonly code: PortErrorCode;
  readonly retryable: boolean;
  constructor(code: PortErrorCode, message: string, opts: { retryable?: boolean; cause?: unknown } = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'PortError';
    this.code = code;
    this.retryable = opts.retryable ?? (code === 'Throttled' || code === 'Unavailable');
  }
}

export function isPortError(e: unknown, code?: PortErrorCode): e is PortError {
  return e instanceof PortError && (code === undefined || e.code === code);
}

/** Thrown by production stubs that are not implemented yet (the implementer of that area replaces them). */
export function notImplemented(what: string): never {
  throw new PortError('NotImplemented', `${what} is not implemented yet`);
}
