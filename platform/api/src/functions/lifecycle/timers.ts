/**
 * One-time schedules of a session (02 §5.2, 01 §3.5): names carry the deadline / keep version, times are on whole
 * minutes, reminders whose time has passed are not created, `ConflictException` counts as success. Extending creates
 * the new version first and deletes the old one afterwards (02 §5.4).
 */
import { ceilToMinute, ScheduleNames, WARNING_OFFSETS_MINUTES, type TimerPayload } from '@atl/shared';
import type { Ctx } from './context.js';

const MIN = 60_000;

interface Planned {
  name: string;
  at: number;
  payload: TimerPayload;
}

export function deadlineSchedules(sid: string, deadlineMs: number, version: number): Planned[] {
  return [
    { name: ScheduleNames.warn15(sid, version), at: deadlineMs - WARNING_OFFSETS_MINUTES.WARN_15 * MIN, payload: { kind: 'WARN_15', sessionId: sid, deadlineVersion: version } },
    { name: ScheduleNames.warn5(sid, version), at: deadlineMs - WARNING_OFFSETS_MINUTES.WARN_5 * MIN, payload: { kind: 'WARN_5', sessionId: sid, deadlineVersion: version } },
    { name: ScheduleNames.expire(sid, version), at: deadlineMs, payload: { kind: 'EXPIRE', sessionId: sid, deadlineVersion: version } },
  ];
}

export function keepSchedules(sid: string, untilMs: number, version: number): Planned[] {
  return [
    { name: ScheduleNames.keepWarn60(sid, version), at: untilMs - WARNING_OFFSETS_MINUTES.KEEP_WARN_60 * MIN, payload: { kind: 'KEEP_WARN_60', sessionId: sid, keepVersion: version } },
    { name: ScheduleNames.keepWarn15(sid, version), at: untilMs - WARNING_OFFSETS_MINUTES.KEEP_WARN_15 * MIN, payload: { kind: 'KEEP_WARN_15', sessionId: sid, keepVersion: version } },
    { name: ScheduleNames.keepExpire(sid, version), at: untilMs, payload: { kind: 'KEEP_EXPIRE', sessionId: sid, keepVersion: version } },
  ];
}

export function idleSchedule(sid: string, readyAtMs: number, idleMinutes: number, deadlineVersion: number): Planned {
  return {
    name: ScheduleNames.readyIdle(sid),
    at: ceilToMinute(readyAtMs + idleMinutes * MIN),
    payload: { kind: 'READY_IDLE', sessionId: sid, deadlineVersion },
  };
}

/** Create the planned schedules whose time is still in the future (aligned to whole minutes). Returns created names. */
export async function createSchedules(ctx: Ctx, planned: Planned[]): Promise<string[]> {
  const out: string[] = [];
  for (const p of planned) {
    const at = ceilToMinute(p.at);
    if (at <= ctx.nowMs()) continue;
    await ctx.ports.scheduler.createOneTime({ name: p.name, group: 'atl-sessions', at: new Date(at), payload: p.payload });
    out.push(p.name);
  }
  return out;
}

export async function deleteSchedules(ctx: Ctx, names: string[]): Promise<void> {
  for (const n of names) await ctx.ports.scheduler.delete(n, 'atl-sessions');
}

export function deadlineScheduleNames(sid: string, version: number): string[] {
  return [ScheduleNames.warn15(sid, version), ScheduleNames.warn5(sid, version), ScheduleNames.expire(sid, version), ...[1, 2, 3].map((r) => ScheduleNames.expire(sid, version, r))];
}

export function keepScheduleNames(sid: string, version: number): string[] {
  return [ScheduleNames.keepWarn60(sid, version), ScheduleNames.keepWarn15(sid, version), ScheduleNames.keepExpire(sid, version), ...[1, 2, 3].map((r) => ScheduleNames.keepExpire(sid, version, r))];
}

/** Every schedule a session may own (all deadline and keep versions, re-triggers, the idle timer). */
export function allScheduleNames(sid: string, deadlineVersion: number, keepVersion: number): string[] {
  const names = [ScheduleNames.readyIdle(sid)];
  for (let v = 1; v <= Math.max(1, deadlineVersion); v++) names.push(...deadlineScheduleNames(sid, v));
  for (let v = 1; v <= keepVersion; v++) names.push(...keepScheduleNames(sid, v));
  return names;
}

/**
 * Early-fired EXPIRE / KEEP_EXPIRE: re-trigger one minute later as `…-r<k>` (at most 3, 02 §5.2) — or, for a kept
 * environment with a live reuse reservation, two minutes later (02 §5.3).
 */
export type ExpirePayload = { kind: 'EXPIRE'; sessionId: string; deadlineVersion: number } | { kind: 'KEEP_EXPIRE'; sessionId: string; keepVersion: number };

export async function rearm(ctx: Ctx, payload: ExpirePayload, afterSeconds: number, retryIndex: number): Promise<boolean> {
  if (retryIndex > 3) return false;
  const name =
    payload.kind === 'EXPIRE'
      ? ScheduleNames.expire(payload.sessionId, payload.deadlineVersion, retryIndex)
      : ScheduleNames.keepExpire(payload.sessionId, payload.keepVersion, retryIndex);
  const at = ceilToMinute(ctx.nowMs() + afterSeconds * 1000);
  await ctx.ports.scheduler.createOneTime({ name, group: 'atl-sessions', at: new Date(at), payload });
  return true;
}
