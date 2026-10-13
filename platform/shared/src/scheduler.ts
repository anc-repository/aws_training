/**
 * EventBridge Scheduler names and payloads — 01 §3.5 (name-table row “调度”), 02 §5.2.
 */
import { assertSid } from './ids.js';
import type { TimerKind } from './functions.js';

export const SCHEDULE_GROUPS = ['atl-sessions', 'atl-system'] as const;
export type ScheduleGroup = (typeof SCHEDULE_GROUPS)[number];

export const SWEEPER_SCHEDULE = 'atl-sweeper';
export const SWEEPER_RATE = 'rate(5 minutes)';
export const TIMER_DLQ = 'atl-timer-dlq';
/** Schedule names are at most 64 characters (01 §3.5). */
export const MAX_SCHEDULE_NAME_LENGTH = 64;

function version(v: number, what: string): number {
  if (!Number.isInteger(v) || v < 1) throw new RangeError(`${what} must be a positive integer, got ${v}`);
  return v;
}
function retry(k: number | undefined): string {
  if (k === undefined) return '';
  if (!Number.isInteger(k) || k < 1 || k > 3) throw new RangeError(`re-trigger index must be 1..3, got ${k}`);
  return `-r${k}`;
}

/** Schedule names (group `atl-sessions` unless stated). `r` = re-trigger index for early-fired EXPIRE / KEEP_EXPIRE. */
export const ScheduleNames = {
  warn15: (sid: string, deadlineVersion: number) => `atl-${assertSid(sid)}-w15-v${version(deadlineVersion, 'deadlineVersion')}`,
  warn5: (sid: string, deadlineVersion: number) => `atl-${assertSid(sid)}-w5-v${version(deadlineVersion, 'deadlineVersion')}`,
  expire: (sid: string, deadlineVersion: number, r?: number) => `atl-${assertSid(sid)}-exp-v${version(deadlineVersion, 'deadlineVersion')}${retry(r)}`,
  readyIdle: (sid: string) => `atl-${assertSid(sid)}-idle-v1`,
  keepWarn60: (sid: string, keepVersion: number) => `atl-${assertSid(sid)}-kw60-v${version(keepVersion, 'keepVersion')}`,
  keepWarn15: (sid: string, keepVersion: number) => `atl-${assertSid(sid)}-kw15-v${version(keepVersion, 'keepVersion')}`,
  keepExpire: (sid: string, keepVersion: number, r?: number) => `atl-${assertSid(sid)}-kexp-v${version(keepVersion, 'keepVersion')}${retry(r)}`,
  /** Group `atl-system`. */
  shareExpire: (shareId: string) => `atl-share-${shareId}-exp`,
} as const;

/** Group of each timer kind. */
export function scheduleGroupOf(kind: TimerKind): ScheduleGroup {
  return kind === 'SHARE_EXPIRE' || kind === 'SWEEP' ? 'atl-system' : 'atl-sessions';
}

/** Minutes before `deadlineAt` / `keep.until` at which warnings fire. */
export const WARNING_OFFSETS_MINUTES = { WARN_15: 15, WARN_5: 5, KEEP_WARN_60: 60, KEEP_WARN_15: 15 } as const;

/** Payload delivered to `atl-timer` (01 §3.5). Old versions are discarded by comparing the version. */
export type TimerPayload =
  | { kind: 'WARN_15' | 'WARN_5' | 'EXPIRE' | 'READY_IDLE'; sessionId: string; deadlineVersion: number }
  | { kind: 'KEEP_WARN_60' | 'KEEP_WARN_15' | 'KEEP_EXPIRE'; sessionId: string; keepVersion: number }
  | { kind: 'SHARE_EXPIRE'; shareId: string }
  | { kind: 'SWEEP' };

/**
 * `deadlineAt` and all reminders are aligned to whole minutes (`at()` seconds are always 00, 02 §5.2): round **up** to the
 * next minute (02 §5.1 T05 “向上取整到整分钟”).
 */
export function ceilToMinute(ms: number): number {
  return Math.ceil(ms / 60_000) * 60_000;
}

/** `at(yyyy-mm-ddThh:mm:ss)` expression in UTC (`ScheduleExpressionTimezone: UTC`). */
export function atExpression(at: Date | number): string {
  const d = new Date(typeof at === 'number' ? at : at.getTime());
  return `at(${d.toISOString().slice(0, 19)})`;
}
