/**
 * Delayed rescans (02 §7.7): `ConcludeRescan` after each RESCAN pass (T21 when BLOCKING residue shows up inside the
 * rescan window) and `FinishFollowUp` at the end of the window (followUp = DONE; the environment's state prefix and
 * lock item are deleted by atl-reaper unless the session is CLEANUP_FAILED, 9.5). Actions of atl-lifecycle.
 */
import type { Ctx } from '../lifecycle/context.js';
import { mutateEnvironment } from '../lifecycle/store/environments.js';
import { mustGetSession, mutateSession, transitionSession } from '../lifecycle/store/sessions.js';
import type { ReclaimSummary } from '../lifecycle/rules.js';

type RescanResult = { summary?: ReclaimSummary } & { Error?: string; Cause?: string };

export async function concludeRescan(ctx: Ctx, p: { sessionId: string; envId: string; index?: number; result?: RescanResult | null }) {
  const s = await mustGetSession(ctx, p.sessionId);
  const summary = p.result?.summary;
  if (!summary) {
    await mutateSession(ctx, s.sid, (cur) => ({
      patch: {
        reclaim: { ...(cur.reclaim ?? { followUp: 'PENDING' as const, rescanAt: [] }), lastRescanError: { index: p.index ?? null, error: p.result?.Error ?? 'unknown', at: ctx.nowIso() } },
      },
    }));
    await ctx.clouds().lifecycle.notify('atl-alerts', `ATL: rescan of ${p.envId} failed`, `Rescan ${p.index ?? '?'} of environment ${p.envId} (session ${s.sid}) failed: ${p.result?.Error ?? 'unknown'}. The next time point repeats it.`).catch(() => undefined);
    return { state: s.state, blocking: null };
  }
  const inWindow = s.reclaim?.followUp === 'PENDING';
  if (summary.blocking > 0 && inWindow && (s.state === 'ENDED' || s.state === 'FAILED')) {
    await transitionSession(ctx, s.sid, {
      from: ['ENDED', 'FAILED'],
      to: 'CLEANUP_FAILED',
      reason: 'RESCAN_BLOCKING',
      patch: (cur) => ({
        cleanup: {
          ...(cur.cleanup ?? { passes: 0, deleted: 0, manual: 0, failed: 0 }),
          passes: (cur.cleanup?.passes ?? 0) + 1,
          deleted: (cur.cleanup?.deleted ?? 0) + summary.deleted,
          manual: summary.manual,
          failed: summary.blocking,
          blocking: summary.blocking,
          review: summary.review,
          hourlyBlocking: summary.hourlyBlocking,
        },
      }),
      events: () => [{ type: 'cleanup.failed', data: { deleted: summary.deleted, manual: summary.manual, blocking: summary.blocking, hourlyBlocking: summary.hourlyBlocking, rescan: p.index ?? null } }],
    });
    await mutateEnvironment(ctx, p.envId, (env) => (env.status === 'RELEASE_FAILED' ? null : { status: 'RELEASE_FAILED' }));
    await ctx.clouds().lifecycle.notify(
      'atl-alerts',
      `ATL: rescan found residue of session ${s.sid}`,
      `A delayed rescan of environment ${p.envId} found ${summary.blocking} BLOCKING resources. See GET /api/v1/sessions/${s.sid}/cleanup.`,
    ).catch(() => undefined);
    return { state: 'CLEANUP_FAILED', blocking: summary.blocking };
  }
  await mutateSession(ctx, s.sid, (cur) => ({
    patch: {
      cleanup: {
        ...(cur.cleanup ?? { passes: 0, deleted: 0, manual: 0, failed: 0 }),
        passes: (cur.cleanup?.passes ?? 0) + 1,
        deleted: (cur.cleanup?.deleted ?? 0) + summary.deleted,
        ...(cur.state === 'CLEANUP_FAILED' ? { blocking: summary.blocking, failed: summary.blocking, hourlyBlocking: summary.hourlyBlocking } : {}),
      },
    },
  }));
  return { state: s.state, blocking: summary.blocking };
}

export async function finishFollowUp(ctx: Ctx, p: { sessionId: string; envId: string }) {
  const r = await mutateSession(ctx, p.sessionId, (s) =>
    s.reclaim?.followUp === 'DONE' ? null : { patch: { reclaim: { ...(s.reclaim ?? { rescanAt: [] }), followUp: 'DONE' as const } } },
  );
  const s = r.session;
  if (s.state !== 'CLEANUP_FAILED') {
    await ctx.ports.invoker.invoke('atl-reaper', { action: 'PurgeEnvState', envId: p.envId, sessionId: s.sid });
  }
  return { state: s.state };
}
