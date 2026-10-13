/**
 * Platform and personal routes (01 §8.2 “平台与个人”): me, progress, mastery, time, platform, guardrails, maintenance,
 * uninstall, exports, settings, members, audit events.
 */
import { createHash } from 'node:crypto';
import { AtlError, isTerminal, NON_TERMINAL_STATES, type SessionState } from '@atl/shared';
import { accepted, created, noContent, ok, withEtag } from '../http/responses.js';
import { parseBody, z } from '../http/validate.js';
import type { RouteHandlers } from '../http/router.js';
import { monthsBetween, stripKeys, type Item, type SessionItem } from '../repositories/index.js';
import { mastery, trackProgress, type ProgressRecord } from '../services/catalog/progress.js';
import { dispatch } from '../services/sessions/agent.js';
import { budgetBlocks } from '../services/sessions/view.js';
import { auditOk, createContext, platformConfig, primaryGroup, principalOf, subjectSub, type ApiContext } from './context.js';
import type { ApiExtensions } from './extensions.js';

type Handler = (ctx: ApiContext) => Promise<import('../http/types.js').HttpResult>;

export function wrap(ext: ApiExtensions, h: Handler): NonNullable<RouteHandlers[keyof RouteHandlers]> {
  return (req) => h(createContext(req, ext));
}

function meView(profile: Item | null, p: { sub: string; email?: string; groups: string[] }): Record<string, unknown> {
  return {
    sub: p.sub,
    email: (profile?.email as string | undefined) ?? p.email ?? null,
    groups: p.groups,
    role: profile?.role ?? null,
    displayName: profile?.displayName ?? null,
    certName: profile?.certName ?? null,
    locale: profile?.locale ?? 'zh-CN',
    notify: profile?.notify ?? {},
    currentTrackId: profile?.currentTrackId ?? 'saa-main',
    onboarding: profile?.onboarding ?? null,
  };
}

const patchMeSchema = z
  .object({
    displayName: z.string().trim().min(1).max(64).optional(),
    certName: z.string().trim().min(1).max(64).nullable().optional(),
    locale: z.enum(['zh-CN', 'en']).optional(),
    notify: z.record(z.string(), z.boolean()).optional(),
    currentTrackId: z.string().regex(/^[a-z][a-z0-9-]{1,31}$/).optional(),
    onboarding: z.object({ completedAt: z.iso.datetime(), version: z.string().max(16) }).optional(),
  })
  .strict();

const settingsSchema = z
  .object({
    limits: z
      .object({
        readyIdleMinutes: z.number().int().min(0).max(240).optional(),
        envMaxAgeDays: z.number().int().min(1).max(30).optional(),
        maxKeepHours: z.number().int().min(1).max(72).optional(),
        maxSessionMinutes: z.number().int().min(300).max(480).optional(),
        extension: z.object({ minutes: z.number().int().min(5).max(60).optional(), maxCount: z.number().int().min(0).max(5).optional() }).strict().optional(),
      })
      .strict()
      .optional(),
    reclaim: z
      .object({
        blockStartOnResidual: z.enum(['ack', 'block', 'ignore']).optional(),
        rescanOffsetsMinutes: z.array(z.number().int().min(5).max(1440)).max(5).optional(),
      })
      .strict()
      .optional(),
    ownership: z.object({ maxWaitMinutes: z.number().int().min(1).max(45).optional() }).strict().optional(),
    terminal: z
      .object({ persistence: z.string().max(32).optional(), streamUrlSigning: z.string().max(32).optional(), keepalive: z.number().int().min(0).max(600).optional() })
      .strict()
      .optional(),
    console: z.object({ longSession: z.boolean().optional() }).strict().optional(),
    preview: z.object({ directHttps: z.enum(['letsencrypt-ip', 'off']).optional() }).strict().optional(),
    agent: z.object({ lateUploadFallback: z.enum(['on', 'off']).optional() }).strict().optional(),
    rateLimits: z.record(z.string(), z.number().int().min(0).max(1000)).optional(),
  })
  .strict();

const SETTINGS_KEYS = ['limits', 'reclaim', 'ownership', 'terminal', 'console', 'preview', 'agent', 'rateLimits', 'workstation', 'accessAnalyzer'] as const;

function settingsView(cfg: Item | null): Record<string, unknown> {
  const out: Record<string, unknown> = { ver: cfg?.ver ?? null };
  for (const k of SETTINGS_KEYS) out[k] = cfg?.[k] ?? null;
  return out;
}

/** Deep-merge a settings patch, refusing values above the install-time caps (01 §8.2 “不超过安装参数给出的上限”). */
function mergeSettings(cfg: Item, patch: z.infer<typeof settingsSchema>): Record<string, unknown> {
  const caps = (cfg.installLimits ?? {}) as { maxSessionMinutes?: number; maxKeepHours?: number; extension?: { minutes?: number; maxCount?: number } };
  const limits = (cfg.limits ?? {}) as Record<string, unknown>;
  const errors: { path: string; message: string }[] = [];
  const cap = (path: string, v: number | undefined, max: number | undefined) => {
    if (v !== undefined && max !== undefined && v > max) errors.push({ path, message: `must not exceed the install parameter (${max})` });
  };
  cap('limits.maxSessionMinutes', patch.limits?.maxSessionMinutes, caps.maxSessionMinutes);
  cap('limits.maxKeepHours', patch.limits?.maxKeepHours, Math.min(caps.maxKeepHours ?? 72, Number(limits.keepHardMaxHours ?? 72)));
  cap('limits.extension.minutes', patch.limits?.extension?.minutes, caps.extension?.minutes);
  cap('limits.extension.maxCount', patch.limits?.extension?.maxCount, caps.extension?.maxCount);
  const hardWait = ((cfg.ownership ?? {}) as { hardMaxWaitMinutes?: number }).hardMaxWaitMinutes ?? 45;
  cap('ownership.maxWaitMinutes', patch.ownership?.maxWaitMinutes, hardWait);
  if (errors.length) throw new AtlError('VALIDATION_FAILED', errors.map((e) => `${e.path}: ${e.message}`).join('; '), { errors });
  const set: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    const cur = (cfg[k] ?? {}) as Record<string, unknown>;
    if (k === 'limits') {
      const lp = v as NonNullable<typeof patch.limits>;
      set.limits = { ...cur, ...lp, extension: { ...((cur.extension ?? {}) as object), ...(lp.extension ?? {}) } };
    } else if (k === 'rateLimits') set.rateLimits = { ...cur, ...(v as object) };
    else set[k] = { ...cur, ...(v as object) };
  }
  return set;
}

export function platformRoutes(ext: ApiExtensions): RouteHandlers {
  return {
    getTime: wrap(ext, async (ctx) => ok({ serverNow: ctx.nowIso })),

    getMe: wrap(ext, async (ctx) => {
      const p = principalOf(ctx);
      const profile = await ctx.repos.users.ensureProfile({ sub: p.sub, email: p.email ?? `${p.username}@unknown.invalid`, role: primaryGroup(p) }, ctx.nowIso);
      return ok(meView(profile, p));
    }),

    patchMe: wrap(ext, async (ctx) => {
      const p = principalOf(ctx);
      const body = parseBody(patchMeSchema, ctx.req.body);
      await ctx.repos.users.ensureProfile({ sub: p.sub, email: p.email ?? `${p.username}@unknown.invalid`, role: primaryGroup(p) }, ctx.nowIso);
      if (body.currentTrackId) {
        const rel = await ctx.catalog.current();
        if (rel) {
          const idx = await ctx.catalog.index(rel.catalogVersion);
          if (idx.tracks.length && !idx.tracks.some((t) => t.id === body.currentTrackId)) throw new AtlError('VALIDATION_FAILED', `unknown track ${body.currentTrackId}`);
        }
      }
      const updated = await ctx.repos.users.patchProfile(p.sub, body as Record<string, unknown>, ctx.nowIso);
      return ok(meView(updated, p));
    }),

    getMyProgress: wrap(ext, async (ctx) => {
      const sub = await subjectSub(ctx);
      const [progress, rel] = await Promise.all([sub ? ctx.repos.users.progress(sub) : Promise.resolve([]), ctx.catalog.current()]);
      const records = progress.map((p) => stripKeys(p) as unknown as ProgressRecord);
      const idx = rel ? await ctx.catalog.index(rel.catalogVersion) : null;
      const tracks = (idx?.tracks ?? []).map((t) => {
        const tp = trackProgress(t, records);
        return { trackId: t.id, title: t.title ?? null, requiredDone: tp.requiredDone, requiredTotal: tp.requiredTotal, completed: tp.completed, eligible: tp.certificate.eligible };
      });
      const learner = sub && sub !== principalOf(ctx).sub ? await ctx.repos.users.profile(sub) : null;
      return withEtag(ctx.req.event, {
        labs: records,
        tracks,
        ...(learner ? { subject: { displayName: learner.displayName ?? null } } : {}),
      });
    }),

    getMyMastery: wrap(ext, async (ctx) => {
      const sub = await subjectSub(ctx);
      const rel = await ctx.catalog.current();
      const progress = sub ? (await ctx.repos.users.progress(sub)).map((p) => stripKeys(p) as unknown as ProgressRecord) : [];
      const idx = rel ? await ctx.catalog.index(rel.catalogVersion) : { cards: [], tracks: [] };
      return ok({ catalogVersion: rel?.catalogVersion ?? null, services: mastery(idx, progress) }, { 'cache-control': 'no-cache' });
    }),

    getPlatform: wrap(ext, async (ctx) => {
      const [cfg, rel] = await Promise.all([platformConfig(ctx), ctx.catalog.current()]);
      if (!cfg) throw new AtlError('NOT_FOUND', 'platform configuration is missing (PLATFORM / CONFIG)');
      return ok({
        version: cfg.version,
        catalogVersion: rel?.catalogVersion ?? null,
        region: cfg.region,
        drRegion: cfg.drRegion ?? null,
        accountId: ctx.deps.env.accountId,
        installationId: cfg.installationId,
        platformUrl: cfg.platformUrl,
        agentApiEndpoint: cfg.agentApiEndpoint ?? null,
        maintenance: !!cfg.maintenance,
        mode: cfg.mode ?? 'NORMAL',
        limits: cfg.limits ?? null,
        allowedInstanceTypes: cfg.allowedInstanceTypes ?? [],
        preflight: cfg.preflight ?? null,
        update: cfg.update ?? null,
        features: {
          terminalRecording: (cfg.terminal as { recording?: string } | undefined)?.recording ?? 'off',
          platformTrail: cfg.platformTrail ?? null,
          accessAnalyzer: (cfg.accessAnalyzer as { mode?: string } | undefined)?.mode ?? null,
          workstation: cfg.workstation ?? null,
        },
      });
    }),

    getGuardrails: wrap(ext, async (ctx) => {
      const cfg = await platformConfig(ctx);
      const budget = (cfg?.budget ?? null) as Record<string, unknown> | null;
      return ok({
        budget: budget ? { amount: budget.amount ?? null, enforcement: budget.enforcement ?? 'block-start', state: budget.state ?? 'OK', stateAt: budget.stateAt ?? null, blocksStart: budgetBlocks(cfg) } : null,
        limits: cfg?.limits ?? null,
        mode: cfg?.mode ?? 'NORMAL',
        maintenance: !!cfg?.maintenance,
        reclaim: cfg?.reclaim ?? null,
        uninstalling: cfg?.mode === 'UNINSTALLING',
        serverNow: ctx.nowIso,
      });
    }),

    setMaintenance: wrap(ext, async (ctx) => {
      const body = parseBody(z.object({ on: z.boolean() }).strict(), ctx.req.body);
      const cfg = await ctx.repos.platform.updateConfig({ maintenance: body.on }, undefined, ctx.nowIso);
      await auditOk(ctx, 'maintenance.set', { details: { on: body.on } });
      return ok({ maintenance: !!cfg.maintenance, ver: cfg.ver });
    }),

    prepareUninstall: wrap(ext, async (ctx) => {
      const p = principalOf(ctx);
      const r = await ctx.lifecycle.startUninstall({ mode: 'prepare', requestedBy: { sub: p.sub }, requestedAt: ctx.nowIso });
      await auditOk(ctx, 'uninstall.prepare', { details: { execution: r.name } });
      return accepted({ execution: r.name, alreadyRunning: r.alreadyRunning, status: '/api/v1/platform/uninstall/status' }, '/api/v1/platform/uninstall/status');
    }),

    getUninstallStatus: wrap(ext, async (ctx) => uninstallStatus(ctx)),

    createExport: wrap(ext, async (ctx) => {
      const p = principalOf(ctx);
      const exportId = createHash('sha256').update(`${p.sub}\n${ctx.req.idempotencyKey ?? ''}`).digest('hex').slice(0, 26);
      const key = `exports/${exportId}.zip`;
      const existing = await ctx.deps.ports.objects.get(ctx.deps.env.buckets.data, key);
      if (existing) {
        const downloadUrl = await ctx.deps.ports.objects.presign(ctx.deps.env.buckets.data, key, { method: 'GET', expiresInSeconds: 900 });
        return ok({ exportId, status: 'ready', downloadUrl, expiresAt: new Date(ctx.nowMs + 900_000).toISOString() });
      }
      await dispatch(ctx, 'atl-certs', { action: 'ExportArchive', exportId, key, sub: p.sub });
      await auditOk(ctx, 'export.create', { target: exportId });
      return accepted({ exportId, status: 'pending', retryWithSameKeyAfterSeconds: 10 });
    }),

    getSettings: wrap(ext, async (ctx) => ok(settingsView(await platformConfig(ctx)))),

    patchSettings: wrap(ext, async (ctx) => {
      const body = parseBody(settingsSchema, ctx.req.body);
      const cfg = await ctx.repos.platform.config(true);
      if (!cfg) throw new AtlError('NOT_FOUND', 'platform configuration is missing');
      const expected = ifMatch(ctx);
      if (expected !== undefined && expected !== cfg.ver) throw new AtlError('PRECONDITION_FAILED', `settings version is ${cfg.ver}`);
      const set = mergeSettings(cfg, body);
      if (!Object.keys(set).length) return ok(settingsView(cfg));
      let updated;
      try {
        updated = await ctx.repos.platform.updateConfig(set, cfg.ver, ctx.nowIso);
      } catch {
        throw new AtlError('PRECONDITION_FAILED', 'settings changed concurrently; reload and retry');
      }
      await auditOk(ctx, 'settings.update', { details: { keys: Object.keys(set) } });
      return ok(settingsView(updated));
    }),

    listMembers: wrap(ext, async (ctx) => {
      const members = await ctx.repos.users.members();
      return ok({ items: members.map((m) => ({ sub: m.sub, email: m.email, role: m.role, displayName: m.displayName ?? null, invitedAt: m.invitedAt ?? null, createdAt: m.createdAt })) });
    }),

    inviteMember: wrap(ext, async (ctx) => {
      const body = parseBody(z.object({ email: z.email().max(254), role: z.enum(['assistant', 'observer']) }).strict(), ctx.req.body);
      const dir = ctx.ext.memberDirectory;
      if (!dir) throw notProvided('member directory (Cognito AdminCreateUser)');
      if ((await ctx.repos.users.members()).some((m) => String(m.email).toLowerCase() === body.email.toLowerCase())) {
        throw new AtlError('VALIDATION_FAILED', `${body.email} is already a member`);
      }
      const { sub } = await dir.invite(body);
      const m = await ctx.repos.users.putMember({ sub, email: body.email, role: body.role, invitedBy: principalOf(ctx).sub }, ctx.nowIso);
      await auditOk(ctx, 'member.invite', { target: sub, details: { role: body.role } });
      return created({ sub: m.sub, email: m.email, role: m.role }, `/api/v1/members/${encodeURIComponent(m.sub)}`);
    }),

    deleteMember: wrap(ext, async (ctx) => {
      const sub = ctx.req.params.sub ?? '';
      const profile = await ctx.repos.users.profile(sub);
      if (!profile) throw new AtlError('NOT_FOUND', 'member not found');
      if (profile.role === 'learner') throw new AtlError('FORBIDDEN_ROLE', 'the learner cannot be removed (01 §5.4)');
      const dir = ctx.ext.memberDirectory;
      if (!dir) throw notProvided('member directory (Cognito AdminDeleteUser)');
      await dir.remove(sub);
      await ctx.repos.users.deleteProfile(sub);
      await auditOk(ctx, 'member.remove', { target: sub });
      return noContent();
    }),

    listAuditEvents: wrap(ext, async (ctx) => {
      const q = ctx.req.query;
      let items: Item[];
      if (q.sessionId) items = await ctx.repos.audit.bySession(q.sessionId);
      else {
        const to = q.to && !Number.isNaN(Date.parse(q.to)) ? new Date(q.to).toISOString() : ctx.nowIso;
        const from = q.from && !Number.isNaN(Date.parse(q.from)) ? new Date(q.from).toISOString() : new Date(Date.parse(to) - 30 * 86_400_000).toISOString();
        items = [];
        for (const month of monthsBetween(from, to)) {
          items.push(...(await ctx.repos.audit.byMonth(month, { from, to })));
          if (items.length >= 500) break;
        }
      }
      return ok({ items: items.slice(0, 500).map((i) => stripKeys(i)) });
    }),
  };
}

function ifMatch(ctx: ApiContext): number | undefined {
  const v = ctx.req.event.headers ? Object.entries(ctx.req.event.headers).find(([k]) => k.toLowerCase() === 'if-match')?.[1] : undefined;
  if (!v) return undefined;
  const m = /^\s*(?:W\/)?"?(\d+)"?\s*$/.exec(v);
  if (!m) throw new AtlError('PRECONDITION_FAILED', 'If-Match must be a version number');
  return Number(m[1]);
}

export function notProvided(what: string): Error {
  const e = new Error(`${what} is not available in this deployment yet`);
  e.name = 'Atl.NotImplemented';
  return e;
}

/** `GET /platform/uninstall/status` (01 §8.3 example, 02 §10.5). */
async function uninstallStatus(ctx: ApiContext) {
  const cfg = await platformConfig(ctx);
  const blockers: Record<string, unknown>[] = [];
  const sessions: SessionItem[] = [];
  for (const st of NON_TERMINAL_STATES as readonly SessionState[]) sessions.push(...(await ctx.repos.sessions.listByState(st, 200)));
  for (const s of sessions) if (!isTerminal(s.state)) blockers.push({ code: 'SESSION_NOT_TERMINAL', sessionId: s.sid, state: s.state, labId: s.labId });
  const followUps = await ctx.repos.sessions.listFollowUps(200).catch(() => [] as SessionItem[]);
  const manual = await ctx.repos.environments.manualItems();
  const blocking = manual.filter((r) => r.severity === 'BLOCKING');
  if (blocking.length) blockers.push({ code: 'MANUAL_RESIDUALS', count: blocking.length, link: '/api/v1/resources/manual' });
  const revokedTimes = [...sessions, ...followUps].map((s) => (typeof s.revokedAt === 'string' ? Date.parse(s.revokedAt) : 0)).filter((t) => t > 0);
  const lastRevoked = revokedTimes.length ? Math.max(...revokedTimes) : 0;
  const revocationsUntil = lastRevoked ? lastRevoked + 75 * 60_000 : 0;
  if (revocationsUntil > ctx.nowMs) blockers.push({ code: 'REVOCATIONS_PENDING', until: new Date(revocationsUntil).toISOString() });
  const endedTimes = [...sessions, ...followUps].map((s) => (typeof s.endedAt === 'string' ? Date.parse(s.endedAt) : 0));
  const lastEnded = endedTimes.length ? Math.max(...endedTimes) : 0;
  return ok({
    ready: blockers.length === 0,
    mode: cfg?.mode ?? 'NORMAL',
    terminationProtection: cfg?.terminationProtection ?? null,
    blockers,
    followUps: followUps.map((s) => ({ sessionId: s.sid, revokedAt: s.revokedAt ?? null })),
    rescanWarning: lastEnded && ctx.nowMs - lastEnded < 6 * 3_600_000 ? '最近一次会话结束不足 6 小时，CloudTrail 中可能还有未到达的事件' : null,
    serverNow: ctx.nowIso,
  });
}
