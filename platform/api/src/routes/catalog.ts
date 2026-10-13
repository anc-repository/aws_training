/**
 * Catalog, tracks, quotes and quizzes (01 §8.2 “目录、学习路径与报价”, “小测”; 05 §8.8; 04 §3.2.11).
 */
import { randomInt } from 'node:crypto';
import { AtlError, eventSourceOf, isCardId, newUlid } from '@atl/shared';
import { created, ok, withEtag } from '../http/responses.js';
import type { RouteHandlers } from '../http/router.js';
import { parseBody, z } from '../http/validate.js';
import { stripKeys, type Item, type SessionItem } from '../repositories/index.js';
import { trackProgress, type ProgressRecord } from '../services/catalog/progress.js';
import type { LabContent, QuizBank, TrackDef } from '../services/catalog/store.js';
import { loadPlatformState, startBlockers, type Blocker } from '../services/sessions/guards.js';
import { createLabQuote } from '../services/sessions/start.js';
import { auditOk, principalOf, rateLimit, subjectSub, type ApiContext } from './context.js';
import type { ApiExtensions } from './extensions.js';
import { wrap } from './platform.js';

async function requireLabParam(ctx: ApiContext): Promise<{ lab: LabContent; catalogVersion: string }> {
  const labId = ctx.req.params.labId ?? '';
  if (!isCardId(labId)) throw new AtlError('NOT_FOUND', `card ${labId} not found`);
  const rel = await ctx.catalog.requireCurrent();
  return { lab: await ctx.catalog.requireLab(labId, rel.catalogVersion), catalogVersion: rel.catalogVersion };
}

async function progressRecords(ctx: ApiContext, sub: string | null): Promise<ProgressRecord[]> {
  return sub ? (await ctx.repos.users.progress(sub)).map((p) => stripKeys(p) as unknown as ProgressRecord) : [];
}

async function defectiveVersions(ctx: ApiContext, catalogVersion: string | null): Promise<Set<string>> {
  const out = new Set<string>();
  if (catalogVersion) {
    const rel = await ctx.repos.platform.getRelease(catalogVersion);
    if (rel?.defective) out.add(catalogVersion);
  }
  return out;
}

/** The environment strip of `GET /labs` (05 §8.8: from the lock and its holder). */
function environmentStrip(st: Awaited<ReturnType<typeof loadPlatformState>>): Record<string, unknown> | null {
  const h = st.holder;
  if (!h) return null;
  const keep = h.keep as { until?: string } | null | undefined;
  return {
    holderLabId: h.labId,
    sessionId: h.sid,
    envId: st.lock?.holderEnvId ?? null,
    state: h.state,
    deadlineAt: h.deadlineAt ?? null,
    keepUntil: keep?.until ?? null,
    reservedBy: st.reservation?.sessionId ?? null,
  };
}

export function catalogRoutes(ext: ApiExtensions): RouteHandlers {
  return {
    getCatalog: wrap(ext, async (ctx) => {
      const [rel, cfg] = await Promise.all([ctx.catalog.requireCurrent(), ctx.repos.platform.config()]);
      const v = rel.catalogVersion;
      return withEtag(
        ctx.req.event,
        {
          catalogVersion: v,
          contentDigest: rel.contentDigest ?? null,
          publishedAt: rel.publishedAt ?? null,
          defective: rel.defective ?? null,
          indexUrl: `/content/${v}/catalog/index.json`,
          cardIntroUrlTemplate: `/content/${v}/catalog/cards/{labId}.json`,
          labUrlTemplate: `/content/${v}/labs/{labId}.json`,
          region: cfg?.region ?? ctx.deps.env.region,
          drRegion: cfg?.drRegion ?? '',
        },
        { etag: `"${v}"`, cacheControl: 'private, max-age=60' },
      );
    }),

    listLabs: wrap(ext, async (ctx) => {
      const sub = await subjectSub(ctx);
      const [rel, progress, st, profile, sessions] = await Promise.all([
        ctx.catalog.current(),
        progressRecords(ctx, sub),
        loadPlatformState(ctx.repos, ctx.nowMs, { residues: false }),
        sub ? ctx.repos.users.profile(sub) : Promise.resolve(null),
        sub ? ctx.repos.sessions.listByUser(sub, { limit: 100 }).then((p) => p.items) : Promise.resolve([] as SessionItem[]),
      ]);
      const lastByLab = new Map<string, SessionItem>();
      for (const s of sessions) if (!lastByLab.has(s.labId)) lastByLab.set(s.labId, s);
      const labIds = new Set([...progress.map((p) => p.labId), ...lastByLab.keys()]);
      const items = [...labIds].sort().map((labId) => {
        const p = progress.find((x) => x.labId === labId);
        const last = lastByLab.get(labId);
        return {
          labId,
          status: p?.status ?? 'not_started',
          attempts: p?.attempts ?? 0,
          bestAttemptId: p?.bestAttemptId ?? null,
          firstCompletedAt: p?.firstCompletedAt ?? null,
          badge: p?.badge ?? null,
          lastSession: last ? { sessionId: last.sid, state: last.state } : null,
        };
      });
      return withEtag(ctx.req.event, {
        catalogVersion: rel?.catalogVersion ?? null,
        currentTrackId: (profile?.currentTrackId as string | undefined) ?? 'saa-main',
        environment: environmentStrip(st),
        items,
        serverNow: ctx.nowIso,
      });
    }),

    getLab: wrap(ext, async (ctx) => {
      const { lab, catalogVersion } = await requireLabParam(ctx);
      const sub = await subjectSub(ctx);
      const [progress, st, sessions, idx] = await Promise.all([
        progressRecords(ctx, sub),
        loadPlatformState(ctx.repos, ctx.nowMs),
        sub ? ctx.repos.sessions.listByUser(sub, { limit: 50, labId: lab.id }).then((p) => p.items) : Promise.resolve([] as SessionItem[]),
        ctx.catalog.index(catalogVersion),
      ]);
      const p = progress.find((x) => x.labId === lab.id);
      const reasons: Blocker[] = [];
      if (lab.status === 'deprecated') reasons.push({ code: 'LAB_DEPRECATED', detail: '卡片已停用，不能开始新会话' });
      for (const pre of lab.prerequisites?.cards ?? []) {
        if (pre.kind !== 'hard') continue;
        const badge = progress.find((x) => x.labId === pre.id)?.badge;
        if (!badge || badge.status !== 'valid') reasons.push({ code: 'HARD_PREREQ_UNMET', detail: `需要先完成 ${pre.id}`, labId: pre.id });
      }
      const blockers = startBlockers(st, { nowMs: ctx.nowMs });
      reasons.push(...blockers.filter((b) => !(b.code === 'ENV_KEPT_EXISTS')));
      let reuse: Record<string, unknown> | null = null;
      if (st.holder?.state === 'KEPT' && st.lock?.holderEnvId) {
        const card = idx.cards.find((c) => c.id === lab.id);
        const recommended = (card?.reuseFrom ?? []).some((r) => r.labId === st.holder!.labId) || st.holder.labId === lab.id;
        reuse = { environmentId: st.lock.holderEnvId, fromLabId: st.holder.labId, sessionId: st.holder.sid, compatible: recommended, ...(recommended ? {} : { reason: 'NOT_IN_REUSE_FROM' }) };
        reasons.push(
          st.reservation
            ? { code: 'REUSE_IN_PROGRESS', detail: `保留环境已被会话 ${st.reservation.sessionId} 预留复用` }
            : { code: 'ENV_KEPT_EXISTS', detail: '有保留中的环境：先释放，或复用该环境', ackable: recommended },
        );
      }
      const variants = [{ id: 'default', select: 'default' }, ...(lab.startProfile?.variants ?? []).map((v) => ({ id: v.id, select: v.select, title: v.title }))];
      // `ackable`: the start dialog can resolve it (residualAck, or reusing a compatible kept environment)
      const canStart = reasons.every((r) => r.ackable === true);
      return withEtag(ctx.req.event, {
        labId: lab.id,
        catalogVersion,
        labVersion: lab.version,
        status: lab.status ?? 'stable',
        progress: { status: p?.status ?? 'not_started', attempts: p?.attempts ?? 0, badge: p?.badge ?? null },
        attempts: sessions.map((s) => ({ sessionId: s.sid, state: s.state, variant: s.variant ?? 'default', createdAt: s.createdAt, readyAt: s.readyAt ?? null, endedAt: s.endedAt ?? null, endReason: s.endReason ?? null })),
        startability: { canStart, reasons, reuse, variants },
        serverNow: ctx.nowIso,
      });
    }),

    createLabQuote: wrap(ext, async (ctx) => {
      const p = principalOf(ctx);
      const body = parseBody(
        z.object({ purpose: z.enum(['START', 'REUSE']), variant: z.string().max(24).optional(), reuseEnvironmentId: z.string().max(26).optional() }).strict(),
        ctx.req.body,
      );
      rateLimit(ctx, 'quote', p.sub, null);
      const labId = ctx.req.params.labId ?? '';
      if (!isCardId(labId)) throw new AtlError('NOT_FOUND', `card ${labId} not found`);
      const quote = await createLabQuote(ctx, p.sub, labId, body);
      return created(quote);
    }),

    listTracks: wrap(ext, async (ctx) => {
      const rel = await ctx.catalog.requireCurrent();
      const [idx, progress] = await Promise.all([ctx.catalog.index(rel.catalogVersion), progressRecords(ctx, await subjectSub(ctx))]);
      const defective = await defectiveVersions(ctx, rel.catalogVersion);
      return ok({
        catalogVersion: rel.catalogVersion,
        items: idx.tracks.map((t) => {
          const tp = trackProgress(t, progress, defective);
          return { ...summaryOf(t), progress: { requiredDone: tp.requiredDone, requiredTotal: tp.requiredTotal, completed: tp.completed, eligible: tp.certificate.eligible } };
        }),
      });
    }),

    getTrack: wrap(ext, async (ctx) => {
      const rel = await ctx.catalog.requireCurrent();
      const sub = await subjectSub(ctx);
      const [idx, progress, certs] = await Promise.all([
        ctx.catalog.index(rel.catalogVersion),
        progressRecords(ctx, sub),
        sub ? ctx.repos.certificates.listByUser(sub) : Promise.resolve([]),
      ]);
      const track = idx.tracks.find((t) => t.id === ctx.req.params.trackId);
      if (!track) throw new AtlError('NOT_FOUND', `track ${String(ctx.req.params.trackId)} not found`);
      const tp = trackProgress(track, progress, await defectiveVersions(ctx, rel.catalogVersion));
      const current = certs.find((c) => c.trackId === track.id && c.status === 'valid');
      return ok({
        track,
        progress: tp,
        certificate: { eligible: tp.certificate.eligible, reasons: tp.certificate.reasons, current: current ? { certId: current.certId, status: current.status } : null },
      });
    }),

    markReleaseDefective: wrap(ext, async (ctx) => {
      const v = ctx.req.params.catalogVersion ?? '';
      const body = parseBody(z.object({ reason: z.string().max(500).optional() }).strict(), ctx.req.body);
      if (!(await ctx.repos.platform.getRelease(v))) throw new AtlError('NOT_FOUND', `content release ${v} not found`);
      const rel = await ctx.repos.platform.markDefective(v, principalOf(ctx).sub, body.reason, ctx.nowIso);
      await auditOk(ctx, 'catalog.mark_defective', { target: v, ...(body.reason ? { details: { reason: body.reason } } : {}) });
      return ok({ catalogVersion: v, defective: rel.defective });
    }),

    ...quizRoutes(ext),
  };
}

function summaryOf(t: TrackDef): Record<string, unknown> {
  const { stages, ...rest } = t;
  return { ...rest, stageCount: stages?.length ?? 0 };
}

// ---------------------------------------------------------------------------------------------------------------
// Quiz (04 §3.2.11): server draws questions, answers never leave the server before grading.

const DEFAULT_DRAW = 3;
const DEFAULT_MAX_ATTEMPTS_PER_DAY = 5;
const ULID = /^[0-7][0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{25}$/;

function shuffle<T>(xs: T[]): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

async function findQuizAttempt(ctx: ApiContext, sub: string, attemptId: string): Promise<Item> {
  if (!ULID.test(attemptId)) throw new AtlError('NOT_FOUND', 'quiz attempt not found');
  const all = await ctx.repos.users.quizAttempts(sub);
  const a = all.find((x) => x.attemptId === attemptId);
  if (!a) throw new AtlError('NOT_FOUND', 'quiz attempt not found');
  return a;
}

async function bankFor(ctx: ApiContext, labId: string, catalogVersion: string): Promise<QuizBank> {
  const bank = await ctx.catalog.quizBank(labId, catalogVersion);
  if (!bank?.questions?.length) throw new AtlError('NOT_FOUND', `card ${labId} has no quiz in content release ${catalogVersion}`);
  return bank;
}

function quizRoutes(ext: ApiExtensions): RouteHandlers {
  return {
    startQuizAttempt: wrap(ext, async (ctx) => {
      const p = principalOf(ctx);
      const { lab, catalogVersion } = await requireLabParam(ctx);
      if (!lab.quiz) throw new AtlError('NOT_FOUND', `card ${lab.id} has no quiz`);
      const bank = await bankFor(ctx, lab.id, catalogVersion);
      const recent = (await ctx.repos.users.quizAttempts(p.sub, lab.id)).filter((a) => ctx.nowMs - Date.parse(String(a.createdAt)) < 86_400_000);
      const maxPerDay = bank.maxAttemptsPerDay ?? DEFAULT_MAX_ATTEMPTS_PER_DAY;
      if (recent.length >= maxPerDay) throw new AtlError('RATE_LIMITED', `at most ${maxPerDay} quiz attempts per day`, { retryAfterSeconds: 3600 });
      const draw = Math.min(lab.quiz.draw ?? DEFAULT_DRAW, bank.questions.length);
      const picked = shuffle(bank.questions).slice(0, draw);
      const attemptId = newUlid(ctx.nowMs);
      const deadlineAt = bank.timeLimitMinutes ? new Date(ctx.nowMs + bank.timeLimitMinutes * 60_000).toISOString() : null;
      const drawn = picked.map((q) => ({ id: q.id, optionOrder: shuffle(q.options.map((o) => o.id)) }));
      await ctx.repos.users.putQuizAttempt(
        p.sub,
        lab.id,
        attemptId,
        { catalogVersion, bankVersion: bank.version ?? null, questions: drawn, answers: {}, status: 'IN_PROGRESS', startedAt: ctx.nowIso, deadlineAt },
        ctx.nowIso,
      );
      return created({
        attemptId,
        labId: lab.id,
        deadlineAt,
        questions: picked.map((q, i) => ({
          id: q.id,
          type: q.type,
          domain: q.domain,
          stem: q.stem,
          options: drawn[i]!.optionOrder.map((oid) => ({ id: oid, text: q.options.find((o) => o.id === oid)!.text })),
        })),
      });
    }),

    saveQuizAnswers: wrap(ext, async (ctx) => {
      const p = principalOf(ctx);
      const body = parseBody(z.object({ answers: z.record(z.string(), z.array(z.string().max(16)).max(10)) }).strict(), ctx.req.body);
      const a = await findQuizAttempt(ctx, p.sub, ctx.req.params.attemptId ?? '');
      if (a.status !== 'IN_PROGRESS') throw new AtlError('INVALID_STATE', 'the quiz attempt was already submitted');
      if (typeof a.deadlineAt === 'string' && Date.parse(a.deadlineAt) < ctx.nowMs) throw new AtlError('INVALID_STATE', 'the quiz time limit has passed');
      const drawn = a.questions as { id: string; optionOrder: string[] }[];
      for (const [qid, opts] of Object.entries(body.answers)) {
        const q = drawn.find((d) => d.id === qid);
        if (!q) throw new AtlError('VALIDATION_FAILED', `question ${qid} is not part of this attempt`);
        for (const o of opts) if (!q.optionOrder.includes(o)) throw new AtlError('VALIDATION_FAILED', `option ${o} is not an option of ${qid}`);
      }
      const answers = { ...((a.answers ?? {}) as Record<string, string[]>), ...body.answers };
      await ctx.repos.users.updateQuizAttempt(p.sub, String(a.labId), String(a.attemptId), { answers, savedAt: ctx.nowIso }, 'IN_PROGRESS', ctx.nowIso);
      return ok({ attemptId: a.attemptId, answers, savedAt: ctx.nowIso });
    }),

    submitQuizAttempt: wrap(ext, async (ctx) => {
      const p = principalOf(ctx);
      const a = await findQuizAttempt(ctx, p.sub, ctx.req.params.attemptId ?? '');
      if (a.status !== 'IN_PROGRESS') throw new AtlError('INVALID_STATE', 'the quiz attempt was already submitted');
      const labId = String(a.labId);
      const bank = await bankFor(ctx, labId, String(a.catalogVersion));
      const answers = (a.answers ?? {}) as Record<string, string[]>;
      const drawn = a.questions as { id: string }[];
      const byDomain: Record<string, { correct: number; total: number }> = {};
      const byService: Record<string, { correct: number; total: number }> = {};
      const results = drawn.map((d) => {
        const q = bank.questions.find((x) => x.id === d.id);
        const given = [...(answers[d.id] ?? [])].sort();
        const right = [...(q?.answer ?? [])].sort();
        const correct = !!q && given.length === right.length && given.every((g, i) => g === right[i]);
        const dom = (byDomain[q?.domain ?? 'unknown'] ??= { correct: 0, total: 0 });
        dom.total++;
        if (correct) dom.correct++;
        for (const svc of q?.services ?? []) {
          const s = (byService[svc] ??= { correct: 0, total: 0 });
          s.total++;
          if (correct) s.correct++;
        }
        return { id: d.id, correct, given, answer: right, explain: q?.explain ?? null, relatesTo: q?.relatesTo ?? null };
      });
      const correct = results.filter((r) => r.correct).length;
      const score = drawn.length ? Math.round((100 * correct) / drawn.length) : 0;
      await ctx.repos.users.updateQuizAttempt(p.sub, labId, String(a.attemptId), { status: 'GRADED', submittedAt: ctx.nowIso, score, correct, total: drawn.length, byDomain, byService }, 'IN_PROGRESS', ctx.nowIso);
      await recordQuizOnBadge(ctx, p.sub, labId, score, byDomain, byService);
      await ctx.deps.ports.events
        .publish([{ source: eventSourceOf('quiz_attempt.graded'), detailType: 'quiz_attempt.graded', detail: { sub: p.sub, labId, attemptId: a.attemptId, score, at: ctx.nowIso } }])
        .catch(() => undefined);
      await auditOk(ctx, 'quiz.submit', { target: `${labId}/${String(a.attemptId)}`, details: { score } });
      return ok({ attemptId: a.attemptId, labId, score, correct, total: drawn.length, byDomain, byService, results });
    }),
  };
}

/** Best quiz results go on the badge (`LabProgress.badge.quiz`) and `quizByService` (04 §8.6); completion is unaffected. */
async function recordQuizOnBadge(
  ctx: ApiContext,
  sub: string,
  labId: string,
  score: number,
  byDomain: Record<string, { correct: number; total: number }>,
  byService: Record<string, { correct: number; total: number }>,
): Promise<void> {
  const prog = await ctx.repos.users.progressOf(sub, labId);
  if (!prog) return;
  const badge = (prog.badge ?? null) as { quiz?: { bestScore?: number; attempts?: number; byDomain?: Record<string, number> } } | null;
  const prevQuiz = badge?.quiz ?? {};
  const best = Math.max(prevQuiz.bestScore ?? 0, score);
  const domains = Object.fromEntries(Object.entries(byDomain).map(([k, v]) => [k, Math.max(prevQuiz.byDomain?.[k] ?? 0, v.total ? v.correct / v.total : 0)]));
  const qbs = { ...((prog.quizByService ?? {}) as Record<string, { correct: number; total: number }>) };
  for (const [svc, v] of Object.entries(byService)) {
    const prev = qbs[svc];
    if (!prev || (v.total && v.correct / v.total > prev.correct / Math.max(prev.total, 1))) qbs[svc] = v;
  }
  const set: Record<string, unknown> = { quizByService: qbs };
  if (badge) set.badge = { ...badge, quiz: { bestScore: best, attempts: (prevQuiz.attempts ?? 0) + 1, byDomain: { ...(prevQuiz.byDomain ?? {}), ...domains } } };
  await ctx.repos.users.updateProgressQuiz(sub, labId, set, ctx.nowIso);
}
