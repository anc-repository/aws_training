/**
 * atl-timer: one-time schedule kinds (02 §5.3). Old versions are discarded by comparing `deadlineVersion` / `keepVersion`;
 * an early EXPIRE / KEEP_EXPIRE is re-triggered one minute later (at most 3 times), never dropped. State writes go
 * through atl-lifecycle (single writer); atl-timer starts the end workflow itself (01 §6.9).
 */
import { ExecutionNames, isPortError, isTerminal, type TimerPayload } from '@atl/shared';
import type { Ctx } from '../lifecycle/context.js';
import { emit } from '../lifecycle/store/events.js';
import { getLock, liveReservation } from '../lifecycle/store/platform.js';
import { getSession } from '../lifecycle/store/sessions.js';
import { rearm, type ExpirePayload } from '../lifecycle/timers.js';

export async function lifecycle<T = unknown>(ctx: Ctx, payload: Record<string, unknown>): Promise<T> {
  return ctx.ports.invoker.invoke<T>('atl-lifecycle', { actor: ctx.actor, ...payload });
}

/** Start an end workflow; `ExecutionAlreadyExists` within the same end phase means “already ending” (02 §2.7). */
export async function startEnd(ctx: Ctx, name: string, input: Record<string, unknown>): Promise<'started' | 'exists'> {
  try {
    await ctx.ports.orchestrator.startExecution({ stateMachine: 'atl-session-end', name, input });
    return 'started';
  } catch (e) {
    if (isPortError(e, 'ExecutionAlreadyExists')) return 'exists';
    throw e;
  }
}

async function retrigger(ctx: Ctx, payload: ExpirePayload, afterSeconds: number): Promise<{ dropped: false; retriggered: boolean }> {
  const version = payload.kind === 'EXPIRE' ? payload.deadlineVersion : payload.keepVersion;
  const { retry } = await lifecycle<{ retry: number }>(ctx, { action: 'NoteTimerRetrigger', sessionId: payload.sessionId, kind: payload.kind, version });
  const ok = await rearm(ctx, payload, afterSeconds, retry);
  return { dropped: false, retriggered: ok };
}

export type TimerResult = { dropped: boolean; reason?: string; [k: string]: unknown };

export async function handleTimer(ctx: Ctx, ev: TimerPayload): Promise<TimerResult> {
  if (ev.kind === 'SWEEP') throw new Error('SWEEP is handled by the sweeper');
  if (ev.kind === 'SHARE_EXPIRE') {
    await ctx.ports.invoker.invokeAsync('atl-certs', { action: 'ShareExpire', shareId: ev.shareId });
    return { dropped: false };
  }
  const s = await getSession(ctx, ev.sessionId);
  if (!s || isTerminal(s.state)) return { dropped: true, reason: 'session ended' };
  const now = ctx.nowMs();

  switch (ev.kind) {
    case 'WARN_15':
    case 'WARN_5': {
      if (ev.deadlineVersion !== (s.deadlineVersion ?? 1)) return { dropped: true, reason: 'old deadline version' };
      if (!['READY', 'RUNNING', 'EXPIRING'].includes(s.state)) return { dropped: true, reason: `state ${s.state}` };
      if (ev.kind === 'WARN_15' && (s.state === 'READY' || s.state === 'RUNNING')) {
        await lifecycle(ctx, { action: 'Transition', sessionId: s.sid, from: ['READY', 'RUNNING'], to: 'EXPIRING', reason: 'WARN_15', deadlineVersion: ev.deadlineVersion }).catch(() => undefined);
      }
      const minutesLeft = ev.kind === 'WARN_15' ? 15 : 5;
      await emit(ctx, s.sid, [{ type: 'session.expiry_warning', data: { minutesLeft, deadlineVersion: ev.deadlineVersion }, actor: 'scheduler' }]);
      await ctx.clouds().lifecycle.notify('atl-notify', `ATL: ${minutesLeft} minutes left`, `Session ${s.sid} (${s.labId}) expires at ${s.deadlineAt}.`).catch(() => undefined);
      return { dropped: false };
    }
    case 'EXPIRE': {
      if (ev.deadlineVersion !== (s.deadlineVersion ?? 1)) return { dropped: true, reason: 'old deadline version' };
      if (s.deadlineAt && now < Date.parse(s.deadlineAt) - 5000) {
        return retrigger(ctx, { kind: 'EXPIRE', sessionId: s.sid, deadlineVersion: ev.deadlineVersion }, 60); // early: re-trigger, never drop
      }
      if (!['READY', 'RUNNING', 'EXPIRING'].includes(s.state)) return { dropped: true, reason: `state ${s.state}` };
      const disposition = s.preferredDisposition?.disposition ?? 'destroy';
      const r = await startEnd(ctx, ExecutionNames.endFirst(s.sid), { sessionId: s.sid, reason: 'EXPIRED', disposition, actor: 'scheduler' });
      return { dropped: false, end: r };
    }
    case 'READY_IDLE': {
      if (s.state !== 'READY') return { dropped: true, reason: `state ${s.state}` };
      const r = await startEnd(ctx, ExecutionNames.endFirst(s.sid), { sessionId: s.sid, reason: 'IDLE_NOT_STARTED', disposition: 'destroy', actor: 'scheduler' });
      return { dropped: false, end: r };
    }
    case 'KEEP_WARN_60':
    case 'KEEP_WARN_15':
    case 'KEEP_EXPIRE': {
      if (s.state !== 'KEPT' || !s.keep || ev.keepVersion !== s.keep.version) return { dropped: true, reason: 'not kept or old keep version' };
      if (ev.kind !== 'KEEP_EXPIRE') {
        const minutesLeft = ev.kind === 'KEEP_WARN_60' ? 60 : 15;
        await emit(ctx, s.sid, [{ type: 'session.keep_expiry_warning', data: { keepUntil: s.keep.until, minutesLeft }, actor: 'scheduler' }]);
        await ctx.clouds().lifecycle.notify('atl-notify', `ATL: kept environment ends in ${minutesLeft} minutes`, `The environment kept by ${s.sid} is released at ${s.keep.until}.`).catch(() => undefined);
        return { dropped: false };
      }
      const again = { kind: 'KEEP_EXPIRE' as const, sessionId: s.sid, keepVersion: ev.keepVersion };
      if (now < Date.parse(s.keep.until) - 5000) return retrigger(ctx, again, 60);
      const lock = await getLock(ctx);
      const pending = liveReservation(lock, now);
      if (pending && pending !== s.sid) return retrigger(ctx, again, 120); // a new session reserved the environment (02 §3.4)
      const r = await startEnd(ctx, ExecutionNames.endRelease(s.sid), { sessionId: s.sid, reason: 'KEEP_EXPIRED', disposition: 'destroy', actor: 'scheduler' });
      return { dropped: false, end: r };
    }
  }
  return { dropped: true, reason: 'unknown kind' };
}
