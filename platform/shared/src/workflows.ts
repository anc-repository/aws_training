/**
 * Step Functions state machines and execution names — 01 §3.3 (name-table rows “状态机”, “执行名”), 02 §2.7, §6.1.
 */
import { assertSid } from './ids.js';
import type { ReclaimPassMode } from './entities.js';

export const STATE_MACHINES = [
  'atl-session-start',
  'atl-session-end',
  'atl-reclaim',
  'atl-reclaim-rescan',
  'atl-module-op',
  'atl-platform-uninstall',
] as const;
export type StateMachineName = (typeof STATE_MACHINES)[number];

export const DEPRECATED_STATE_MACHINES = ['atl-session-lifecycle', 'atl-session-cleanup'] as const;

export function isStateMachineName(value: unknown): value is StateMachineName {
  return typeof value === 'string' && (STATE_MACHINES as readonly string[]).includes(value);
}

/** ASL source file of a state machine (01 §13: `platform/workflows/statemachines/<name>.asl.json`). */
export function aslFileName(name: StateMachineName): string {
  return `${name}.asl.json`;
}

function nonNegativeInt(n: number, what: string): number {
  if (!Number.isInteger(n) || n < 0) throw new RangeError(`${what} must be a non-negative integer, got ${n}`);
  return n;
}

/** Deterministic execution names (02 §2.7: one name per “end phase”, never shared across phases). */
export const ExecutionNames = {
  start: (sid: string) => `start-${assertSid(sid)}`,
  /** First end: ENDING, cancel, compensation, budget, uninstall, admin. */
  endFirst: (sid: string) => `end-${assertSid(sid)}-1`,
  /** Release of a kept environment (KEPT → CLEANING). */
  endRelease: (sid: string) => `end-${assertSid(sid)}-rel`,
  /** Reclaim retry; k = LabSession.cleanupRetryCount + 1. */
  endRetry: (sid: string, k: number) => `end-${assertSid(sid)}-retry-${nonNegativeInt(k, 'k')}`,
  reclaim: (envId: string, mode: ReclaimPassMode, n: number) => `reclaim-${envId}-${mode.toLowerCase()}-${nonNegativeInt(n, 'n')}`,
  rescan: (envId: string) => `rescan-${envId}`,
  moduleOp: (sid: string, n: number) => `modop-${assertSid(sid)}-${nonNegativeInt(n, 'n')}`,
  uninstall: (n: number) => `uninstall-${nonNegativeInt(n, 'n')}`,
} as const;

/** Standard workflow execution name limit (80 characters). */
export const MAX_EXECUTION_NAME_LENGTH = 80;
