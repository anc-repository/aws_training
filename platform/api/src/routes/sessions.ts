/**
 * Session lifecycle and environment routes (01 §8.2 “会话生命周期与环境”, semantics 02 §3, §5, §6.1, §7.9, §8, §12).
 */
import { AtlError, isEnvId, isSessionState, type SessionState } from '@atl/shared';
import { SkPrefix } from '../data/keys.js';
import { parseLimit } from '../http/pagination.js';
import { accepted, apiPath, ifMatchVersion, noContent, ok, withEtag } from '../http/responses.js';
import type { RouteHandlers } from '../http/router.js';
import { parseBody, z } from '../http/validate.js';
import { stripKeys, type SessionItem } from '../repositories/index.js';
import { pollSessionEvents, EVENTS_DEFAULT_LIMIT, EVENTS_MAX_LIMIT } from '../services/events/index.js';
import { cleanupMarkdown, cleanupReport, manualResources, resourceView, sessionCost } from '../services/sessions/cleanup.js';
import { createSessionQuote, endSession, extend, extendKeep, heartbeat, releaseKeep, resolveCleanupItem, retryCleanup } from '../services/sessions/control.js';
import { sessionView } from '../services/sessions/bundle.js';
import { createSession, currentSession } from '../services/sessions/start.js';
import { sessionListItem } from '../services/sessions/view.js';
import { actorOf, auditOk, loadSession, principalOf, rateLimit, requireState, subjectSub, type ApiContext } from './context.js';
import type { ApiExtensions } from './extensions.js';
import { wrap } from './platform.js';

function checkIfMatch(ctx: ApiContext, s: SessionItem): void {
  const v = ifMatchVersion(ctx.req.event);
  if (v === undefined) return;
  if (Number.isNaN(v) || v !== s.ver) throw new AtlError('PRECONDITION_FAILED', `session version is ${s.ver}`, { ver: s.ver });
}

async function viewResult(ctx: ApiContext, s: SessionItem, status: 200 | 202 = 200) {
  const view = await sessionView(ctx, s);
  return status === 202 ? accepted(view, apiPath('/sessions', s.sid)) : withEtag(ctx.req.event, view);
}

const createSessionSchema = z
  .object({
    labId: z.string().min(4).max(28),
    quoteId: z.string().min(10).max(40),
    costAcknowledged: z.boolean().optional(),
    variant: z.string().max(24).optional(),
    trackId: z.string().regex(/^[a-z][a-z0-9-]{1,31}$/).optional(),
    reuseEnvironmentId: z.string().refine(isEnvId, 'must be an environment id').optional(),
    residualAck: z.boolean().optional(),
    learnerInputs: z.record(z.string().max(32), z.string().max(256)).optional(),
    workstation: z.enum(['ec2', 'cloudshell']).optional(),
  })
  .strict();

const endSchema = z
  .object({
    disposition: z.enum(['destroy', 'keep']),
    keepHours: z.number().int().min(1).max(72).optional(),
    quoteId: z.string().max(40).optional(),
    when: z.enum(['now', 'at-expiry']).default('now'),
    keepPrerequisites: z.array(z.enum(['route53-hosted-zone', 'ses-identity', 'acm-certificate'])).max(5).optional(),
    saveMode: z.boolean().optional(),
  })
  .strict();

export function sessionRoutes(ext: ApiExtensions): RouteHandlers {
  return {
    createSession: wrap(ext, async (ctx) => {
      const p = principalOf(ctx);
      const body = parseBody(createSessionSchema, ctx.req.body);
      const s = await createSession(ctx, p, actorOf(ctx), body, ctx.req.requestId);
      await auditOk(ctx, 'session.start', { sessionId: s.sid, target: body.labId, details: { variant: s.variant, quoteId: body.quoteId, reuse: body.reuseEnvironmentId ?? null } });
      return viewResult(ctx, s, 202);
    }),

    listSessions: wrap(ext, async (ctx) => {
      const sub = await subjectSub(ctx);
      const limit = parseLimit(ctx.req.query);
      const states = (ctx.req.query.state ?? '')
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean);
      if (states.some((x) => !isSessionState(x))) throw new AtlError('VALIDATION_FAILED', 'state must be session states separated by commas');
      const labId = ctx.req.query.labId || undefined;
      const scope = `sessions|${sub ?? '-'}|${states.join(',')}|${labId ?? ''}`;
      const startKey = ctx.cursors.decode(scope, ctx.req.query.cursor);
      if (!sub) return ok({ items: [], next: null });
      const page = await ctx.repos.sessions.listByUser(sub, { limit, ...(startKey ? { startKey } : {}), ...(states.length ? { states: states as SessionState[] } : {}), ...(labId ? { labId } : {}) });
      return ok({ items: page.items.map(sessionListItem), next: ctx.cursors.encode(scope, page.lastKey) });
    }),

    getCurrentSession: wrap(ext, async (ctx) => {
      const sub = await subjectSub(ctx);
      const s = sub ? await currentSession(ctx, sub) : null;
      if (!s) return noContent();
      return viewResult(ctx, s);
    }),

    getSession: wrap(ext, async (ctx) => viewResult(ctx, await loadSession(ctx, ctx.req.params.sid))),

    listSessionEvents: wrap(ext, async (ctx) => {
      const s = await loadSession(ctx, ctx.req.params.sid);
      const limit = parseLimit(ctx.req.query, EVENTS_DEFAULT_LIMIT, EVENTS_MAX_LIMIT);
      const page = await pollSessionEvents(ctx.repos, s.sid, s.state, ctx.req.query.after || undefined, limit, ctx.nowMs);
      return ok(page);
    }),

    heartbeat: wrap(ext, async (ctx) => {
      const s = await loadSession(ctx, ctx.req.params.sid);
      const body = parseBody(z.object({ workbench: z.boolean().optional() }).strict(), ctx.req.body);
      const cur = await heartbeat(ctx, s, actorOf(ctx), !!body.workbench);
      return ok({ serverNow: ctx.nowIso, state: cur.state, ver: cur.ver, deadlineAt: cur.deadlineAt ?? null, deadlineVersion: cur.deadlineVersion ?? null });
    }),

    createSessionQuote: wrap(ext, async (ctx) => {
      const s = await loadSession(ctx, ctx.req.params.sid);
      const body = parseBody(
        z.object({ purpose: z.enum(['EXTEND', 'KEEP']), minutes: z.number().int().min(1).max(120).optional(), keepHours: z.number().int().min(1).max(72).optional() }).strict(),
        ctx.req.body,
      );
      rateLimit(ctx, 'quote', principalOf(ctx).sub, null);
      return ok(await createSessionQuote(ctx, s, body));
    }),

    extendSession: wrap(ext, async (ctx) => {
      const s = await loadSession(ctx, ctx.req.params.sid);
      checkIfMatch(ctx, s);
      const body = parseBody(z.object({ minutes: z.number().int().min(1).max(120), quoteId: z.string().max(40), expectedDeadlineVersion: z.number().int().min(1) }).strict(), ctx.req.body);
      const updated = await extend(ctx, s, actorOf(ctx), body);
      await auditOk(ctx, 'session.extend', { sessionId: s.sid, details: { minutes: body.minutes, quoteId: body.quoteId } });
      return viewResult(ctx, updated);
    }),

    endSession: wrap(ext, async (ctx) => {
      const s = await loadSession(ctx, ctx.req.params.sid);
      checkIfMatch(ctx, s);
      const body = parseBody(endSchema, ctx.req.body);
      const r = await endSession(ctx, s, actorOf(ctx), body);
      await auditOk(ctx, body.disposition === 'keep' ? 'session.keep' : 'session.end', { sessionId: s.sid, details: { when: body.when, disposition: body.disposition, keepHours: body.keepHours ?? null } });
      const fresh = (await ctx.repos.sessions.get(s.sid, true)) ?? r.session;
      return viewResult(ctx, fresh, 202);
    }),

    extendKeep: wrap(ext, async (ctx) => {
      const s = await loadSession(ctx, ctx.req.params.sid);
      const body = parseBody(z.object({ hours: z.number().int().min(1).max(72), quoteId: z.string().max(40) }).strict(), ctx.req.body);
      const updated = await extendKeep(ctx, s, actorOf(ctx), body);
      await auditOk(ctx, 'session.keep_extend', { sessionId: s.sid, details: { hours: body.hours } });
      return viewResult(ctx, updated);
    }),

    releaseKeep: wrap(ext, async (ctx) => {
      const s = await loadSession(ctx, ctx.req.params.sid);
      await releaseKeep(ctx, s, actorOf(ctx));
      await auditOk(ctx, 'session.keep_release', { sessionId: s.sid });
      return viewResult(ctx, (await ctx.repos.sessions.get(s.sid, true)) ?? s, 202);
    }),

    getCleanup: wrap(ext, async (ctx) => {
      const s = await loadSession(ctx, ctx.req.params.sid);
      const report = await cleanupReport(ctx, s);
      if ((ctx.req.query.format ?? 'json') === 'md') {
        return { statusCode: 200, headers: { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'no-store', 'content-disposition': `attachment; filename="cleanup-${s.sid}.md"` }, body: cleanupMarkdown(report) };
      }
      if (ctx.req.query.format && ctx.req.query.format !== 'json') throw new AtlError('VALIDATION_FAILED', 'format must be json or md');
      return ok(report);
    }),

    retryCleanup: wrap(ext, async (ctx) => {
      const s = await loadSession(ctx, ctx.req.params.sid);
      const r = await retryCleanup(ctx, s, actorOf(ctx));
      await auditOk(ctx, 'session.cleanup_retry', { sessionId: s.sid, details: { k: r.k } });
      return viewResult(ctx, (await ctx.repos.sessions.get(s.sid, true)) ?? s, 202);
    }),

    resolveCleanupItem: wrap(ext, async (ctx) => {
      const s = await loadSession(ctx, ctx.req.params.sid);
      const body = parseBody(z.object({ note: z.string().max(500).optional() }).strict(), ctx.req.body);
      const r = await resolveCleanupItem(ctx, s, actorOf(ctx), ctx.req.params.resourceKey ?? '', body.note);
      await auditOk(ctx, 'resource.resolve', { sessionId: s.sid, target: String(r.resourceKey) });
      return accepted(r);
    }),

    listSessionResources: wrap(ext, async (ctx) => {
      const s = await loadSession(ctx, ctx.req.params.sid);
      const state = ctx.req.query.state;
      const items = (await ctx.repos.environments.resourcesBySession(s.sid)).filter((r) => !state || r.cleanupState === state);
      return ok({ sessionId: s.sid, items: items.map(resourceView) });
    }),

    listManualResources: wrap(ext, async (ctx) => ok(await manualResources(ctx))),

    getSessionCost: wrap(ext, async (ctx) => {
      const s = await loadSession(ctx, ctx.req.params.sid);
      const quoteId = (s.costQuote as { quoteId?: string } | undefined)?.quoteId;
      const quote = quoteId ? await ctx.repos.users.quote(s.sub, quoteId) : null;
      return ok(await sessionCost(ctx, s, quote));
    }),

    getCurrentEnvironment: wrap(ext, async (ctx) => {
      const lock = await ctx.repos.platform.lock();
      if (!lock?.holderEnvId) return noContent();
      const [env, holder] = await Promise.all([ctx.repos.environments.get(lock.holderEnvId), lock.holderSessionId ? ctx.repos.sessions.get(lock.holderSessionId) : null]);
      if (!env) return noContent();
      const quoteId = (holder?.costQuote as { quoteId?: string } | undefined)?.quoteId;
      const quote = holder && quoteId ? await ctx.repos.users.quote(holder.sub, quoteId) : null;
      const env2 = stripKeys(env);
      return ok({
        ...env2,
        session: holder ? { sessionId: holder.sid, labId: holder.labId, state: holder.state, deadlineAt: holder.deadlineAt ?? null, keep: holder.keep ?? null } : null,
        reservedBy: lock.pendingSessionId && lock.pendingUntil && Date.parse(lock.pendingUntil) > ctx.nowMs ? lock.pendingSessionId : null,
        hourlyEstimate: quote?.hourly ?? null,
        keepUntil: env.keepUntil ?? (holder?.keep as { until?: string } | undefined)?.until ?? null,
        serverNow: ctx.nowIso,
      });
    }),

    repairEnvironment: wrap(ext, async (ctx) => {
      const envId = ctx.req.params.envId ?? '';
      if (!isEnvId(envId)) throw new AtlError('NOT_FOUND', 'environment not found');
      const lock = await ctx.repos.platform.lock();
      if (lock?.holderEnvId !== envId || !lock.holderSessionId) throw new AtlError('INVALID_STATE', 'only the active environment can be repaired');
      const s = await loadSession(ctx, lock.holderSessionId);
      requireState(s, ['READY', 'RUNNING', 'EXPIRING'], 'repair');
      rateLimit(ctx, 'moduleOp', s.sid, await ctx.repos.platform.config());
      const ops = await ctx.repos.sessions.children(s.sid, SkPrefix.moduleOp, { all: true });
      const r = await ctx.lifecycle.startModuleOp(s.sid, ops.items.length + 1, { envId, op: 'repair', requestId: ctx.req.requestId, requestedBy: principalOf(ctx).sub });
      await auditOk(ctx, 'environment.repair', { sessionId: s.sid, target: envId, details: { execution: r.name } });
      return accepted({ envId, sessionId: s.sid, execution: r.name, state: 'queued' }, apiPath('/sessions', s.sid));
    }),
  };
}
