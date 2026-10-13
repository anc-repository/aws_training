/**
 * Steps, checks and platform actions (01 §8.2 “步骤、检测与平台动作”, semantics 04 §5, §8). Reads come straight from
 * the session partition; requests that change the check state are handed to `atl-checks` asynchronously (01 §3.2);
 * manual confirmations and their review are written by atl-api (01 §7.2 writer column).
 */
import { AtlError, newUlid, type SessionState } from '@atl/shared';
import { Gsi2, Keys, SkPrefix } from '../data/keys.js';
import { accepted, apiPath, created, ok, withEtag } from '../http/responses.js';
import { parseLimit } from '../http/pagination.js';
import type { RouteHandlers } from '../http/router.js';
import { parseBody, z } from '../http/validate.js';
import { isConditionFailed, stripKeys, type Item, type SessionItem } from '../repositories/index.js';
import { emitSessionEvents } from '../services/events/index.js';
import { dispatch } from '../services/sessions/agent.js';
import { auditOk, canIssueAccess, loadSession, platformConfig, primaryGroup, principalOf, rateLimit, requireState, type ApiContext } from './context.js';
import type { ApiExtensions } from './extensions.js';
import { wrap } from './platform.js';

const LIVE: readonly SessionState[] = ['READY', 'RUNNING', 'EXPIRING'];
const STEP_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const ULID = /^[0-7][0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{25}$/;
const SENSITIVE_VAR = /(secret|password|token|key)$/i;

function stepParam(ctx: ApiContext): string {
  const id = ctx.req.params.stepId ?? '';
  if (!STEP_ID.test(id)) throw new AtlError('NOT_FOUND', 'step not found');
  return id;
}

async function labOf(ctx: ApiContext, s: SessionItem) {
  return typeof s.catalogVersion === 'string' ? ctx.catalog.lab(s.labId, s.catalogVersion).catch(() => null) : null;
}

async function requireStep(ctx: ApiContext, s: SessionItem, stepId: string) {
  const lab = await labOf(ctx, s);
  const step = lab?.steps?.find((st) => st.id === stepId) ?? null;
  if (lab && !step) throw new AtlError('NOT_FOUND', `step ${stepId} is not part of card ${s.labId}`);
  return { lab, step };
}

/** Mask an account id except its last 4 digits (04 §4.4 `mask`). */
const maskAccount = (acct: string) => `${'*'.repeat(Math.max(0, acct.length - 4))}${acct.slice(-4)}`;

async function stepAction(ctx: ApiContext, kind: 'read' | 'drift-ack' | 'skip' | 'unskip') {
  const s = await loadSession(ctx, ctx.req.params.sid);
  requireState(s, LIVE, `step ${kind}`);
  const stepId = stepParam(ctx);
  const { step } = await requireStep(ctx, s, stepId);
  if ((kind === 'skip' || kind === 'unskip') && step && !step.optional) throw new AtlError('VALIDATION_FAILED', `step ${stepId} is not optional`);
  const body = (ctx.req.body ?? {}) as { checkKey?: unknown; note?: unknown };
  await dispatch(ctx, 'atl-checks', {
    action: 'StepAction',
    kind,
    sessionId: s.sid,
    stepId,
    by: { sub: principalOf(ctx).sub, role: primaryGroup(principalOf(ctx)) },
    at: ctx.nowIso,
    ...(typeof body.checkKey === 'string' ? { checkKey: body.checkKey } : {}),
    ...(typeof body.note === 'string' ? { note: body.note.slice(0, 500) } : {}),
  });
  return accepted({ sessionId: s.sid, stepId, action: kind, status: 'queued' });
}

async function findConfirmation(ctx: ApiContext, sid: string, confirmationId: string): Promise<Item> {
  if (!ULID.test(confirmationId)) throw new AtlError('NOT_FOUND', 'confirmation not found');
  const all = (await ctx.repos.sessions.children(sid, SkPrefix.manual, { all: true })).items;
  const c = all.find((x) => x.confirmationId === confirmationId);
  if (!c) throw new AtlError('NOT_FOUND', 'confirmation not found');
  return c;
}

export function progressRoutes(ext: ApiExtensions): RouteHandlers {
  return {
    listSteps: wrap(ext, async (ctx) => {
      const s = await loadSession(ctx, ctx.req.params.sid);
      const items = (await ctx.repos.sessions.children(s.sid, SkPrefix.step, { all: true })).items;
      return withEtag(ctx.req.event, { sessionId: s.sid, items: items.map((i) => stripKeys(i)) });
    }),

    getSessionProgress: wrap(ext, async (ctx) => {
      const s = await loadSession(ctx, ctx.req.params.sid);
      const [steps, attempt, lab] = await Promise.all([ctx.repos.sessions.children(s.sid, SkPrefix.step, { all: true }), ctx.repos.sessions.attempt(s.sid), labOf(ctx, s)]);
      const byId = new Map(steps.items.map((st) => [String(st.stepId), st]));
      const order = lab?.steps?.map((st) => ({ id: st.id, optional: !!st.optional, title: st.title })) ?? steps.items.map((st) => ({ id: String(st.stepId), optional: false, title: null }));
      const rows = order.map((o) => {
        const r = byId.get(o.id);
        return { stepId: o.id, title: o.title, optional: o.optional, state: (r?.state as string | undefined) ?? 'available', firstPassedAt: r?.firstPassedAt ?? null, flags: r?.flags ?? [] };
      });
      const counted = rows.filter((r) => !r.optional && r.state !== 'skipped');
      return withEtag(ctx.req.event, {
        sessionId: s.sid,
        attempt: attempt ? stripKeys(attempt) : null,
        status: (attempt?.status as string | undefined) ?? null,
        steps: rows,
        stepsDone: counted.filter((r) => ['done', 'done_manual', 'drifted'].includes(r.state)).length,
        stepsTotal: counted.length,
        drifted: rows.filter((r) => r.state === 'drifted').map((r) => r.stepId),
        missing: counted.filter((r) => !['done', 'done_manual'].includes(r.state)).map((r) => r.stepId),
        ownershipPending: (attempt?.ownershipPending as unknown[] | undefined) ?? [],
      });
    }),

    getVars: wrap(ext, async (ctx) => {
      const s = await loadSession(ctx, ctx.req.params.sid);
      const [env, attempt, cfg, lab] = await Promise.all([
        typeof s.envId === 'string' ? ctx.repos.environments.get(s.envId) : Promise.resolve(null),
        ctx.repos.sessions.attempt(s.sid),
        platformConfig(ctx),
        labOf(ctx, s),
      ]);
      const values = ((attempt?.variables ?? {}) as Record<string, unknown>) ?? {};
      const declared = lab?.variables ?? {};
      const vars = Object.entries(declared).map(([name, d]) => {
        const v = values[name];
        return { name, label: d.label, from: d.from, value: v === undefined ? null : SENSITIVE_VAR.test(name) ? '‹masked›' : v, pattern: d.pattern ?? null, example: d.example ?? null };
      });
      return ok({
        sessionId: s.sid,
        session: {
          id: s.sid,
          region: cfg?.region ?? ctx.deps.env.region,
          accountId: maskAccount(ctx.deps.env.accountId),
          env: env?.envName ?? null,
          envId: env?.envId ?? s.envId ?? null,
          variant: s.variant ?? 'default',
          deadlineAt: s.deadlineAt ?? null,
          readyAt: s.readyAt ?? null,
        },
        platform: { origin: cfg?.platformUrl ?? null, drRegion: cfg?.drRegion ?? '' },
        learner: { inputs: s.learnerInputs ?? {} },
        target: { appBaseUrl: (env?.endpoints as { baseUrl?: string } | undefined)?.baseUrl ?? null },
        vars,
      });
    }),

    putVar: wrap(ext, async (ctx) => {
      const s = await loadSession(ctx, ctx.req.params.sid);
      requireState(s, LIVE, 'filling a variable');
      const name = ctx.req.params.name ?? '';
      const body = parseBody(z.object({ value: z.string().max(512) }).strict(), ctx.req.body);
      const lab = await labOf(ctx, s);
      const decl = lab?.variables?.[name];
      if (!decl || decl.from !== 'input') throw new AtlError('NOT_FOUND', `variable ${name} is not an input variable of card ${s.labId}`);
      let re: RegExp;
      try {
        re = new RegExp(decl.pattern);
      } catch {
        throw new AtlError('INTERNAL', `variable ${name} has an invalid pattern`);
      }
      if (!re.test(body.value)) throw new AtlError('VALIDATION_FAILED', `value does not match ${decl.pattern}`, { errors: [{ path: 'value', message: `must match ${decl.pattern}` }] });
      try {
        await ctx.repos.sessions.updateChild(Keys.labAttempt(s.sid), {
          set: { [`variables`]: { ...(((await ctx.repos.sessions.attempt(s.sid))?.variables ?? {}) as object), [name]: body.value }, updatedAt: ctx.nowIso },
          condition: { expression: 'attribute_exists(PK)' },
        });
      } catch (e) {
        if (isConditionFailed(e)) throw new AtlError('INVALID_STATE', 'variables can be filled once the attempt has started (READY)');
        throw e;
      }
      return ok({ name, value: body.value, savedAt: ctx.nowIso });
    }),

    createStepCheckRun: wrap(ext, async (ctx) => {
      const s = await loadSession(ctx, ctx.req.params.sid);
      const stepId = stepParam(ctx);
      const body = parseBody(z.object({ checkIds: z.array(z.string().max(64)).max(20).optional(), force: z.boolean().optional() }).strict(), ctx.req.body);
      if (!canIssueAccess(s, ctx.nowMs)) throw new AtlError('INVALID_STATE', `checks cannot run while the session is ${s.state}`, { state: s.state });
      await requireStep(ctx, s, stepId);
      const p = principalOf(ctx);
      const role = primaryGroup(p);
      rateLimit(ctx, role === 'assistant' ? 'checkRunAssistant' : 'checkRun', p.sub, await platformConfig(ctx));
      const runId = newUlid(ctx.nowMs);
      await dispatch(ctx, 'atl-checks', { action: 'RunChecks', runId, sessionId: s.sid, stepId, checkIds: body.checkIds ?? null, force: !!body.force, trigger: 'user', requestedBy: { sub: p.sub, role } });
      await auditOk(ctx, 'check_run.request', { sessionId: s.sid, target: stepId, details: { runId } });
      return accepted({ runId, state: 'queued' }, apiPath('/sessions', s.sid, '/check-runs', runId));
    }),

    createCheckRun: wrap(ext, async (ctx) => {
      const s = await loadSession(ctx, ctx.req.params.sid);
      const body = parseBody(z.object({ scope: z.enum(['lab', 'final-preview']), force: z.boolean().optional() }).strict(), ctx.req.body);
      if (!canIssueAccess(s, ctx.nowMs)) throw new AtlError('INVALID_STATE', `checks cannot run while the session is ${s.state}`, { state: s.state });
      const p = principalOf(ctx);
      const role = primaryGroup(p);
      rateLimit(ctx, role === 'assistant' ? 'checkRunAssistant' : 'checkRun', p.sub, await platformConfig(ctx));
      const runId = newUlid(ctx.nowMs);
      await dispatch(ctx, 'atl-checks', { action: 'RunChecks', runId, sessionId: s.sid, scope: body.scope, force: !!body.force, trigger: 'user', requestedBy: { sub: p.sub, role } });
      await auditOk(ctx, 'check_run.request', { sessionId: s.sid, target: body.scope, details: { runId } });
      return accepted({ runId, state: 'queued' }, apiPath('/sessions', s.sid, '/check-runs', runId));
    }),

    listCheckRuns: wrap(ext, async (ctx) => {
      const s = await loadSession(ctx, ctx.req.params.sid);
      const limit = parseLimit(ctx.req.query);
      const stepId = ctx.req.query.stepId;
      const scope = `runs|${s.sid}|${stepId ?? ''}`;
      const startKey = ctx.cursors.decode(scope, ctx.req.query.cursor);
      const page = stepId
        ? await ctx.repos.table.queryPage(
            { pk: Keys.labSession(s.sid).PK, sk: { beginsWith: SkPrefix.checkRun }, descending: true, consistent: true, filter: { expression: 'stepId = :st', values: { ':st': stepId } }, ...(startKey ? { startKey } : {}) },
            limit,
          )
        : await ctx.repos.sessions.children(s.sid, SkPrefix.checkRun, { limit, descending: true, ...(startKey ? { startKey } : {}) });
      return ok({ items: page.items.map((i) => stripKeys(i)), next: ctx.cursors.encode(scope, page.lastKey) });
    }),

    getCheckRun: wrap(ext, async (ctx) => {
      const s = await loadSession(ctx, ctx.req.params.sid);
      const runId = ctx.req.params.runId ?? '';
      if (!ULID.test(runId)) throw new AtlError('NOT_FOUND', 'check run not found');
      const run = await ctx.repos.sessions.getChild(Keys.checkRun(s.sid, runId));
      if (!run) return accepted({ runId, state: 'queued' }); // requested, atl-checks has not written it yet
      return ok(stripKeys(run));
    }),

    createManualConfirmation: wrap(ext, async (ctx) => {
      const s = await loadSession(ctx, ctx.req.params.sid);
      requireState(s, LIVE, 'a manual confirmation');
      const stepId = stepParam(ctx);
      const body = parseBody(
        z.object({ checkId: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/), observed: z.string().min(1).max(2000), note: z.string().trim().min(6).max(2000), evidence: z.string().max(4096).optional() }).strict(),
        ctx.req.body,
      );
      await requireStep(ctx, s, stepId);
      const confirmationId = newUlid(ctx.nowMs);
      const checkDefs = ((await labOf(ctx, s))?.checks ?? {}) as Record<string, { type?: string }>;
      const kind = checkDefs[body.checkId]?.type === 'manual' ? 'native' : 'degraded';
      const pending = kind === 'degraded';
      const p = principalOf(ctx);
      await ctx.repos.sessions.putChild({
        ...Keys.manualConfirmation(s.sid, stepId, body.checkId, confirmationId),
        ...(Gsi2.manualConfirmation(pending, ctx.nowIso, s.sid) ?? {}),
        type: 'ManualConfirmation',
        ver: 1,
        createdAt: ctx.nowIso,
        updatedAt: ctx.nowIso,
        confirmationId,
        sessionId: s.sid,
        stepId,
        checkId: body.checkId,
        kind,
        observed: body.observed,
        note: body.note,
        evidence: body.evidence ?? null,
        result: body.evidence ? 'manual_evidence' : 'manual',
        submittedBy: p.sub,
        review: null,
      });
      await emitSessionEvents(ctx.deps, ctx.repos, s.sid, [{ type: 'manual_confirmation.submitted', data: { confirmationId, stepId, checkId: body.checkId, decision: null } }]);
      await dispatch(ctx, 'atl-checks', { action: 'ApplyManualConfirmation', sessionId: s.sid, stepId, checkId: body.checkId, confirmationId });
      await auditOk(ctx, 'manual_confirmation.submit', { sessionId: s.sid, target: `${stepId}/${body.checkId}` });
      return created({ confirmationId, stepId, checkId: body.checkId, kind, result: body.evidence ? 'manual_evidence' : 'manual', reviewPending: pending });
    }),

    reviewManualConfirmation: wrap(ext, async (ctx) => {
      const s = await loadSession(ctx, ctx.req.params.sid);
      const body = parseBody(z.object({ decision: z.enum(['approve', 'reject']), comment: z.string().max(2000).default('') }).strict(), ctx.req.body);
      const c = await findConfirmation(ctx, s.sid, ctx.req.params.confirmationId ?? '');
      if (c.review) throw new AtlError('INVALID_STATE', 'the confirmation was already reviewed');
      const p = principalOf(ctx);
      const review = { by: p.sub, decision: body.decision, comment: body.comment, at: ctx.nowIso };
      try {
        await ctx.repos.sessions.updateChild({ PK: String(c.PK), SK: String(c.SK) }, {
          set: { review, updatedAt: ctx.nowIso },
          remove: ['GSI2PK', 'GSI2SK'],
          condition: { expression: 'attribute_not_exists(review) OR review = :null', values: { ':null': null } },
        });
      } catch (e) {
        if (isConditionFailed(e)) throw new AtlError('INVALID_STATE', 'the confirmation was already reviewed');
        throw e;
      }
      await emitSessionEvents(ctx.deps, ctx.repos, s.sid, [{ type: 'manual_confirmation.reviewed', data: { confirmationId: c.confirmationId, decision: body.decision } }]);
      await dispatch(ctx, 'atl-checks', { action: 'ApplyManualReview', sessionId: s.sid, stepId: c.stepId, checkId: c.checkId, confirmationId: c.confirmationId, decision: body.decision });
      await auditOk(ctx, 'manual_confirmation.review', { sessionId: s.sid, target: String(c.confirmationId), details: { decision: body.decision } });
      return ok({ confirmationId: c.confirmationId, review });
    }),

    markStepRead: wrap(ext, (ctx) => stepAction(ctx, 'read')),
    ackDrift: wrap(ext, (ctx) => stepAction(ctx, 'drift-ack')),
    skipStep: wrap(ext, (ctx) => stepAction(ctx, 'skip')),
    unskipStep: wrap(ext, (ctx) => stepAction(ctx, 'unskip')),

    submitSession: wrap(ext, async (ctx) => {
      const s = await loadSession(ctx, ctx.req.params.sid);
      requireState(s, LIVE, 'submitting');
      await dispatch(ctx, 'atl-checks', { action: 'SubmitAttempt', sessionId: s.sid, trigger: 'submit', requestedBy: { sub: principalOf(ctx).sub } });
      await auditOk(ctx, 'submit', { sessionId: s.sid });
      return accepted({ sessionId: s.sid, status: 'verifying' }, apiPath('/sessions', s.sid, '/progress'));
    }),

    requestModuleOp: wrap(ext, async (ctx) => {
      const s = await loadSession(ctx, ctx.req.params.sid);
      const body = parseBody(z.object({ actionId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/) }).strict(), ctx.req.body);
      requireState(s, LIVE, 'a platform action');
      if (!canIssueAccess(s, ctx.nowMs)) throw new AtlError('INVALID_STATE', 'the session has expired');
      const allowed = ((s.cardFacts as { platformActions?: string[] } | undefined)?.platformActions ?? []) as string[];
      if (!allowed.includes(body.actionId)) throw new AtlError('OP_NOT_ALLOWED', `${body.actionId} is not a platform action of card ${s.labId}`, { allowed });
      rateLimit(ctx, 'moduleOp', s.sid, await platformConfig(ctx));
      const ops = await ctx.repos.sessions.children(s.sid, SkPrefix.moduleOp, { all: true });
      const opId = newUlid(ctx.nowMs);
      const r = await ctx.lifecycle.startModuleOp(s.sid, ops.items.filter((o) => o.source === 'platform').length + 1, {
        envId: s.envId ?? null,
        actionId: body.actionId,
        opId,
        requestId: ctx.req.requestId,
        requestedBy: principalOf(ctx).sub,
      });
      await auditOk(ctx, 'module_op.request', { sessionId: s.sid, target: body.actionId, details: { execution: r.name, opId } });
      return accepted({ opId, actionId: body.actionId, execution: r.name, state: 'queued' }, apiPath('/sessions', s.sid, '/module-ops'));
    }),

    listModuleOps: wrap(ext, async (ctx) => {
      const s = await loadSession(ctx, ctx.req.params.sid);
      const items = (await ctx.repos.sessions.children(s.sid, SkPrefix.moduleOp, { all: true, descending: true })).items;
      return ok({ sessionId: s.sid, items: items.map((i) => stripKeys(i)) });
    }),
  };
}
