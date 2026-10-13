/** A Step Functions error (name + cause). Thrown by tasks, Fail states, timeouts and runtime problems. */
export class StatesError extends Error {
  readonly error: string;
  readonly cause_: string;
  constructor(error: string, cause = '') {
    super(`${error}: ${cause}`);
    this.name = 'StatesError';
    this.error = error;
    this.cause_ = cause;
  }
}

/**
 * Error name of an exception thrown by a task handler: a `StatesError` keeps its name; otherwise the exception's `name`
 * (dev Lambda handlers throw errors named like `Atl.LockBusy`), as Lambda reports `errorType`.
 */
export function toStatesError(e: unknown): StatesError {
  if (e instanceof StatesError) return e;
  if (e instanceof Error) {
    const name = e.name && e.name !== 'Error' ? e.name : 'Error';
    return new StatesError(name, e.message);
  }
  return new StatesError('Error', String(e));
}

/**
 * Does `ErrorEquals` match? `States.ALL` matches everything except `States.Runtime`; `States.TaskFailed` matches any task
 * failure except `States.Timeout` (Step Functions rules; also not `States.Runtime`).
 */
export function errorMatches(errorEquals: readonly string[], error: string): boolean {
  if (error === 'States.Runtime') return errorEquals.includes('States.Runtime');
  if (errorEquals.includes(error)) return true;
  if (errorEquals.includes('States.ALL')) return true;
  if (errorEquals.includes('States.TaskFailed') && error !== 'States.Timeout') return true;
  return false;
}
