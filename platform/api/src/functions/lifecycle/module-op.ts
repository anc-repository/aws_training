/**
 * atl-module-op tasks (01 §3.3, 02 §4.3, §5.8): BeginModuleOp (state gate, allow-list, per-session serialisation,
 * ModuleOp record, expected-outage window) and FinishModuleOp.
 */
import { encodeJsonArgs, Keys, newUlid, runnerRunId, type AtlOp } from '@atl/shared';
import type { Ctx } from './context.js';
import { WorkflowError } from './errors.js';
import { closeOutageWindow, openOutageWindow } from './requests.js';
import { getConfig } from './store/platform.js';
import { mustGetSession, mutateSession } from './store/sessions.js';
import { emit } from './store/events.js';

export interface ModuleOpInput {
  sessionId: string;
  actionId: string;
  n: number;
  requestedBy?: string | null;
}

export async function beginModuleOp(ctx: Ctx, p: { input: ModuleOpInput; executionName: string }) {
  const { sessionId: sid, actionId, n } = p.input;
  const s0 = await mustGetSession(ctx, sid);
  if (!['READY', 'RUNNING', 'EXPIRING'].includes(s0.state)) throw new WorkflowError('Atl.SessionNotRunning', `session is ${s0.state}`);
  if (!s0.cardFacts.platformActions.includes(actionId)) throw new WorkflowError('Atl.OpNotAllowed', `${actionId} is not a platform action of ${s0.labId}`);
  if (!s0.envId) throw new WorkflowError('Atl.SessionNotRunning', 'the session has no environment');
  const def = s0.cardSnapshot.platformActions.find((a) => a.id === actionId)!;
  // serialise the platform actions of one session (a stale marker of a finished execution is taken over)
  if (s0.moduleOpRunning && s0.moduleOpRunning !== p.executionName) {
    const arn = ctx.ports.orchestrator.executionArn('atl-module-op', s0.moduleOpRunning);
    const running = await ctx.ports.orchestrator.describeExecution(arn).then((d) => d.status === 'RUNNING').catch(() => false);
    if (running) throw new WorkflowError('Atl.ModuleOpBusy', `${s0.moduleOpRunning} is still running`);
  }
  const opId = newUlid(ctx.nowMs());
  const isXstk = actionId.startsWith('xstk-');
  const op: AtlOp = isXstk ? 'extra-stack' : 'module-op';
  const runId = isXstk ? runnerRunId(sid, 'extra-stack', 100 + n) : runnerRunId(sid, 'module-op', n);
  const args = isXstk ? { action: 'deploy', stackIds: [actionId.slice('xstk-'.length)] } : { actionId };
  await mutateSession(ctx, sid, (s) => {
    if (s.moduleOpRunning && s.moduleOpRunning !== p.executionName && s.moduleOpRunning !== s0.moduleOpRunning) {
      throw new WorkflowError('Atl.ModuleOpBusy', `${s.moduleOpRunning} took the session`);
    }
    return { patch: { moduleOpRunning: p.executionName } };
  });
  const now = ctx.nowIso();
  await ctx.main.put({
    ...Keys.moduleOp(sid, opId),
    type: 'ModuleOp',
    ver: 1,
    createdAt: now,
    updatedAt: now,
    opId,
    source: 'platform',
    op: def.op === 'extra-stack' ? 'enable' : def.op,
    actionId,
    moduleId: def.module,
    args,
    startedAt: now,
    finishedAt: null,
    exitCode: null,
    runId,
    executionName: p.executionName,
    requestedBy: p.input.requestedBy ?? null,
  });
  await emit(ctx, sid, [{ type: 'module_op.started', data: { opId, moduleId: def.module, op: def.op, source: 'platform', actionId } }]);
  if (def.interruptsManagementChannel) {
    const cfg = await getConfig(ctx);
    await openOutageWindow(ctx, { sessionId: sid, channel: 'lab', maxMinutes: cfg.outage.maxMinutes, reason: def.title || actionId, actionId });
  }
  return { op, runId, envId: s0.envId, labId: s0.labId, argsB64: encodeJsonArgs(args), timeoutMinutes: 60, opId };
}

export async function finishModuleOp(
  ctx: Ctx,
  p: { sessionId: string; opId: string | null; runId: string | null; executionName: string; status: 'SUCCEEDED' | 'FAILED' | 'REJECTED'; error?: { Error?: string; Cause?: string } | null },
) {
  const sid = p.sessionId;
  const now = ctx.nowIso();
  let moduleId: string | null = null;
  let actionId: string | null = null;
  let op: string | null = null;
  if (p.opId) {
    const item = await ctx.main.get(Keys.moduleOp(sid, p.opId));
    if (item) {
      moduleId = (item.moduleId as string | null) ?? null;
      actionId = (item.actionId as string | null) ?? null;
      op = (item.op as string | null) ?? null;
      await ctx.main.update(Keys.moduleOp(sid, p.opId), {
        finishedAt: now,
        updatedAt: now,
        status: p.status,
        summary: p.status === 'SUCCEEDED' ? 'ok' : (p.error?.Error ?? 'failed'),
      });
    }
  }
  await mutateSession(ctx, sid, (s) => (s.moduleOpRunning === p.executionName ? { patch: { moduleOpRunning: null } } : null)).catch(() => undefined);
  if (actionId) await closeOutageWindow(ctx, { sessionId: sid, actionId }).catch(() => undefined);
  if (p.opId) {
    await emit(ctx, sid, [
      {
        type: p.status === 'SUCCEEDED' ? 'module_op.succeeded' : 'module_op.failed',
        data: { opId: p.opId, moduleId, op, source: 'platform', actionId, runId: p.runId, error: p.error?.Error ?? null },
      },
    ]);
  }
  return { status: p.status };
}
