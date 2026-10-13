/**
 * atl-agent routes (01 §8.2 “Agent（工作台，SigV4）”, “Internal（运行器，SigV4）”, fallback route of 01 §5.3). The public
 * routes of atl-public are served by functions/public/handler.ts (owned by atl-certs, which writes the records it reads).
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { AtlError, isSid } from '@atl/shared';
import { accepted, created, noContent, ok } from '../http/responses.js';
import type { RouteHandlers } from '../http/router.js';
import { header } from '../http/types.js';
import { parseBody, z } from '../http/validate.js';
import { Keys } from '../data/keys.js';
import {
  agentContext,
  createAttachment,
  getExperimentRunForAgent,
  loadAgentSession,
  MAX_RESULT_BYTES,
  recordRunnerProgress,
  registerExperimentRun,
  registerRunnerGrant,
  reportModuleOp,
  requireAgentState,
  uploadExperimentResult,
} from '../services/sessions/agent.js';
import { auditOk, rateLimit, type ApiContext } from './context.js';
import type { ApiExtensions } from './extensions.js';
import { wrap } from './platform.js';

const moduleOpSchema = z
  .object({
    opId: z.string().max(26).optional(),
    phase: z.enum(['started', 'finished']),
    op: z.enum(['enable', 'disable', 'profile-apply', 'status', 'set']),
    moduleId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/),
    actionId: z.string().max(64).optional(),
    args: z.record(z.string(), z.unknown()).optional(),
    exitCode: z.number().int().optional(),
    summary: z.string().max(2000).optional(),
    runId: z.string().max(64).optional(),
  })
  .strict();

function rawSize(ctx: ApiContext): number {
  const b = ctx.req.event.body ?? '';
  return ctx.req.event.isBase64Encoded ? Math.floor((b.length * 3) / 4) : Buffer.byteLength(b, 'utf8');
}

export function agentRoutes(ext: ApiExtensions): RouteHandlers {
  return {
    agentGetContext: wrap(ext, async (ctx) => {
      const s = await loadAgentSession(ctx, ctx.req.agent!.sid);
      return ok(await agentContext(ctx, s));
    }),

    agentRegisterExperimentRun: wrap(ext, async (ctx) => {
      const s = await loadAgentSession(ctx, ctx.req.agent!.sid);
      requireAgentState(s, 'default');
      const body = parseBody(
        z
          .object({
            module: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/),
            experiment: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
            label: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/),
            scenario: z.string().max(64).optional(),
            params: z.record(z.string(), z.unknown()).optional(),
            variant: z.unknown().optional(),
            window: z.unknown().optional(),
            nonce: z.string().max(128).optional(),
          })
          .strict(),
        ctx.req.body,
      );
      rateLimit(ctx, 'experimentRegister', s.sid, await ctx.repos.platform.config());
      const r = await registerExperimentRun(ctx, s, ctx.req.agent!.arn, body);
      await auditOk(ctx, 'agent.experiment_register', { sessionId: s.sid, target: `${body.module}/${body.experiment}/${body.label}`, details: { runId: r.runId } });
      return created(r, String(r.uploadUrl));
    }),

    agentPutExperimentResult: wrap(ext, async (ctx) => {
      const s = await loadAgentSession(ctx, ctx.req.agent!.sid);
      const runId = ctx.req.params.runId ?? '';
      const r = await uploadExperimentResult(ctx, s, runId, ctx.req.agent!.arn, ctx.req.body, rawSize(ctx));
      await auditOk(ctx, 'agent.experiment_upload', { sessionId: s.sid, target: runId });
      return accepted(r);
    }),

    agentGetExperimentRun: wrap(ext, async (ctx) => {
      const s = await loadAgentSession(ctx, ctx.req.agent!.sid);
      return ok(await getExperimentRunForAgent(ctx, s, ctx.req.params.runId ?? ''));
    }),

    agentCreateAttachment: wrap(ext, async (ctx) => {
      const s = await loadAgentSession(ctx, ctx.req.agent!.sid);
      const body = parseBody(
        z.object({ name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/), contentType: z.string().max(100).optional(), size: z.number().int().min(0).optional(), sha256: z.string().max(80).optional() }).strict(),
        ctx.req.body,
      );
      return created(await createAttachment(ctx, s, ctx.req.params.runId ?? '', body));
    }),

    agentReportModuleOp: wrap(ext, async (ctx) => {
      const s = await loadAgentSession(ctx, ctx.req.agent!.sid);
      requireAgentState(s, 'default');
      const body = parseBody(moduleOpSchema, ctx.req.body);
      const r = await reportModuleOp(ctx, s, 'agent', body);
      await auditOk(ctx, 'agent.module_op_report', { sessionId: s.sid, target: `${body.op} ${body.moduleId}`, details: { phase: body.phase, opId: r.opId } });
      return accepted(r);
    }),

    // ---- internal (runner)
    internalRunEvents: wrap(ext, async (ctx) => {
      const caller = ctx.req.internal!;
      const runId = ctx.req.params.runId ?? '';
      const raw = ctx.req.body as unknown;
      const lines = Array.isArray(raw) ? raw : raw && typeof raw === 'object' && Array.isArray((raw as { lines?: unknown }).lines) ? (raw as { lines: unknown[] }).lines : raw ? [raw] : [];
      if (lines.some((l) => !l || typeof l !== 'object' || Array.isArray(l))) throw new AtlError('VALIDATION_FAILED', 'progress lines must be objects');
      const n = await recordRunnerProgress(ctx, runId, caller.op, lines as Record<string, unknown>[]);
      await auditOk(ctx, 'internal.run_report', { sessionId: caller.sid, target: runId, details: { lines: n } });
      return noContent();
    }),

    internalCredentialGrant: wrap(ext, async (ctx) => {
      const caller = ctx.req.internal!;
      const body = parseBody(
        z.object({ roleSessionName: z.string().max(64).optional(), issuedAt: z.string().max(40).optional(), expiresAt: z.string().max(40).optional() }).strict(),
        ctx.req.body,
      );
      const r = await registerRunnerGrant(ctx, ctx.req.params.runId ?? '', caller, body);
      await auditOk(ctx, 'internal.run_report', { sessionId: caller.sid, target: ctx.req.params.runId ?? null, details: { grant: r.grantId } });
      return created(r);
    }),

    internalReportModuleOp: wrap(ext, async (ctx) => {
      const caller = ctx.req.internal!;
      const s = await loadAgentSession(ctx, caller.sid);
      const body = parseBody(moduleOpSchema, ctx.req.body);
      const r = await reportModuleOp(ctx, s, 'runner', body);
      await auditOk(ctx, 'internal.run_report', { sessionId: s.sid, target: `${body.op} ${body.moduleId}`, details: { phase: body.phase, opId: r.opId } });
      return accepted(r);
    }),

    // ---- fallback upload (01 §5.3; disabled unless PlatformConfig.agent.lateUploadFallback = on)
    agentFallbackPutResult: wrap(ext, async (ctx) => {
      const cfg = await ctx.repos.platform.config();
      if ((cfg?.agent as { lateUploadFallback?: string } | undefined)?.lateUploadFallback !== 'on') throw new AtlError('NOT_FOUND', 'not found');
      const runId = ctx.req.params.runId ?? '';
      const token = header(ctx.req.event, 'x-atl-run-token');
      const body = (ctx.req.body ?? {}) as { sessionId?: unknown };
      if (rawSize(ctx) > MAX_RESULT_BYTES) throw new AtlError('TOO_LARGE', `result exceeds ${MAX_RESULT_BYTES} bytes`);
      if (!token || typeof body.sessionId !== 'string' || !isSid(body.sessionId)) throw new AtlError('RUN_NOT_FOUND', 'run not found');
      const s = await loadAgentSession(ctx, body.sessionId);
      const run = await ctx.repos.sessions.getChild(Keys.experimentRun(s.sid, runId));
      const hash = typeof run?.runTokenHash === 'string' ? run.runTokenHash : null;
      const given = createHash('sha256').update(token).digest('hex');
      if (!run || !hash || hash.length !== given.length || !timingSafeEqual(Buffer.from(hash), Buffer.from(given))) throw new AtlError('RUN_NOT_FOUND', 'run not found');
      const r = await uploadExperimentResult(ctx, s, runId, 'run-token', ctx.req.body, rawSize(ctx), { viaFallback: true });
      await auditOk(ctx, 'agent.experiment_upload', { sessionId: s.sid, target: runId, details: { via: 'fallback' } });
      return accepted(r);
    }),
  };
}
