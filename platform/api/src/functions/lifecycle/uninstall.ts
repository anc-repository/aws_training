/**
 * atl-platform-uninstall tasks (02 §10.5, 01 §4.8): BeginUninstall, UninstallEndSessions, UninstallStatus,
 * FinishUninstall. Every step is idempotent (deterministic execution names) so the guard can re-drive it on retries.
 */
import { ExecutionNames, isPortError } from '@atl/shared';
import type { Ctx } from './context.js';
import { MINUTE } from './context.js';
import { cancelRequested } from './end.js';
import { releaseKept, retryCleanup } from './requests.js';
import { concludeRescan } from '../rescan/rescan.js';
import { getConfig, getLock, liveReservation, updateConfig } from './store/platform.js';
import { sweepSessions } from './store/records.js';
import { getSession, mutateSession } from './store/sessions.js';
import type { SessionRecord } from './store/model.js';

/** The guard answers CloudFormation before the 3600 s custom-resource limit (02 §10.5). */
export const GUARD_DEADLINE_MS = 55 * MINUTE;
export const PREPARE_GIVE_UP_MS = 6 * 60 * MINUTE;

export async function beginUninstall(
  ctx: Ctx,
  p: { input: { trigger?: 'prepare' | 'guard'; cfn?: Record<string, unknown> | null; requestedBy?: string | null }; executionName: string },
) {
  const guard = p.input.trigger === 'guard';
  const cfg = await getConfig(ctx);
  const startedAt = ctx.nowIso();
  const deadlineAt = guard ? new Date(ctx.nowMs() + GUARD_DEADLINE_MS).toISOString() : null;
  await updateConfig(ctx, {
    mode: 'UNINSTALLING',
    maintenance: true,
    uninstall: {
      ...(cfg.uninstall ?? {}),
      executionName: p.executionName,
      trigger: p.input.trigger ?? 'prepare',
      requestedBy: p.input.requestedBy ?? null,
      startedAt,
      deadlineAt,
      outcome: null,
      reason: null,
      finishedAt: null,
    },
  });
  return { guard, deadlineAt, cfn: p.input.cfn ?? null };
}

async function startEnd(ctx: Ctx, name: string, input: Record<string, unknown>): Promise<boolean> {
  try {
    await ctx.ports.orchestrator.startExecution({ stateMachine: 'atl-session-end', name, input });
    return true;
  } catch (e) {
    if (isPortError(e, 'ExecutionAlreadyExists')) return false;
    throw e;
  }
}

async function stopStart(ctx: Ctx, s: SessionRecord): Promise<void> {
  const arn = s.startExecutionArn ?? ctx.ports.orchestrator.executionArn('atl-session-start', ExecutionNames.start(s.sid));
  await ctx.ports.orchestrator.stopExecution(arn, { error: 'Atl.Superseded', cause: 'PLATFORM_UNINSTALL' }).catch(() => undefined);
}

/** Drive every session towards a terminal state (idempotent). */
export async function driveUninstall(ctx: Ctx): Promise<number> {
  let started = 0;
  const sessions = await sweepSessions(ctx);
  // first fail the starts that reserve a kept environment, so that the kept environment can be released (02 §10.5 step 2)
  const lock = await getLock(ctx);
  const reserving = liveReservation(lock, ctx.nowMs());
  for (const s of sessions) {
    try {
      switch (s.state) {
        case 'REQUESTED':
          await stopStart(ctx, s);
          await cancelRequested(ctx, s.sid, 'PLATFORM_UNINSTALL');
          break;
        case 'PROVISIONING':
        case 'READY':
        case 'RUNNING':
        case 'EXPIRING':
          if (await startEnd(ctx, ExecutionNames.endFirst(s.sid), { sessionId: s.sid, reason: 'PLATFORM_UNINSTALL', disposition: 'destroy', actor: 'system' })) started++;
          break;
        case 'KEPT':
          if (reserving && reserving !== s.sid) {
            const r = await getSession(ctx, reserving);
            if (r?.state === 'REQUESTED') {
              await stopStart(ctx, r);
              await cancelRequested(ctx, r.sid, 'PLATFORM_UNINSTALL');
            }
          }
          await releaseKept(ctx, { sessionId: s.sid, reason: 'PLATFORM_UNINSTALL', actor: 'system' });
          started++;
          break;
        case 'CLEANUP_FAILED':
          if (!s.uninstallRetried) {
            await mutateSession(ctx, s.sid, () => ({ patch: { uninstallRetried: true } }));
            await retryCleanup(ctx, { sessionId: s.sid, actor: 'system' });
            started++;
          }
          break;
        case 'ENDED':
        case 'FAILED':
          // inside the rescan window: one immediate RESCAN-like pass instead of waiting (7.7 point 5)
          if (s.envId && s.reclaim?.followUp === 'PENDING') {
            const name = ExecutionNames.reclaim(s.envId, 'UNINSTALL', 1);
            try {
              await ctx.ports.orchestrator.startExecution({ stateMachine: 'atl-reclaim', name, input: { envId: s.envId, sessionId: s.sid, mode: 'UNINSTALL' } });
              started++;
            } catch (e) {
              if (!isPortError(e, 'ExecutionAlreadyExists')) throw e;
            }
          }
          break;
        default:
          break; // ENDING / CLEANING: an end workflow is running
      }
    } catch (e) {
      console.warn(JSON.stringify({ msg: 'uninstall: could not drive session', sid: s.sid, state: s.state, error: e instanceof Error ? e.message : String(e) }));
    }
  }
  return started;
}

export async function uninstallEndSessions(ctx: Ctx) {
  return { started: await driveUninstall(ctx) };
}

export async function uninstallStatus(ctx: Ctx, p: { deadlineAt?: string | null }) {
  await driveUninstall(ctx);
  const sessions = await sweepSessions(ctx);
  let settled = true;
  let blocking = 0;
  const open: string[] = [];
  for (const s of sessions) {
    if (s.state === 'CLEANUP_FAILED') {
      blocking += Math.max(1, s.cleanup?.blocking ?? 0);
      if (!s.uninstallRetried) settled = false;
      continue;
    }
    if (s.state === 'ENDED' || s.state === 'FAILED') {
      // the immediate rescan of the uninstall: wait for it, then conclude it like a rescan
      if (s.envId && s.reclaim?.followUp === 'PENDING' && !s.uninstallRescanConcluded) {
        const arn = ctx.ports.orchestrator.executionArn('atl-reclaim', ExecutionNames.reclaim(s.envId, 'UNINSTALL', 1));
        const d = await ctx.ports.orchestrator.describeExecution(arn).catch(() => null);
        if (!d || d.status === 'RUNNING') {
          settled = false;
          open.push(`${s.sid}: rescan running`);
          continue;
        }
        const summary = (d.output as { summary?: unknown } | undefined)?.summary;
        await concludeRescan(ctx, { sessionId: s.sid, envId: s.envId, index: -1, result: summary ? ({ summary } as never) : { Error: d.error ?? 'FAILED' } });
        await mutateSession(ctx, s.sid, () => ({ patch: { uninstallRescanConcluded: true } }));
        const after = await getSession(ctx, s.sid);
        if (after?.state === 'CLEANUP_FAILED') blocking += Math.max(1, after.cleanup?.blocking ?? 0);
      }
      continue;
    }
    settled = false;
    open.push(`${s.sid}: ${s.state}`);
  }
  const cfg = await getConfig(ctx);
  const startedAt = typeof cfg.uninstall?.startedAt === 'string' ? Date.parse(cfg.uninstall.startedAt) : ctx.nowMs();
  const giveUp = (p.deadlineAt ? ctx.nowMs() >= Date.parse(p.deadlineAt) : false) || ctx.nowMs() - startedAt > PREPARE_GIVE_UP_MS;
  const reason = !settled
    ? `reclaim still running in the background (${open.join(', ') || 'pending'}); retry the stack deletion later`
    : blocking > 0
      ? `${blocking} BLOCKING resources remain; handle them on the platform's uninstall page and retry the deletion`
      : 'all sessions reclaimed';
  return { settled, blocking, giveUp, reason };
}

export async function finishUninstall(ctx: Ctx, p: { result: { outcome: 'SUCCESS' | 'FAILED'; reason: string } }) {
  const cfg = await getConfig(ctx);
  await updateConfig(ctx, { uninstall: { ...(cfg.uninstall ?? {}), outcome: p.result.outcome, reason: p.result.reason, finishedAt: ctx.nowIso() } });
  if (p.result.outcome === 'SUCCESS') await ctx.ports.scheduler.setSweeperEnabled(false).catch(() => undefined);
  return { outcome: p.result.outcome };
}
