/**
 * 08 §9.2 requests implemented by the definition of 08 while 01 has not registered them (route table `pending01`), and
 * the refinements 08 asks for on registered routes (platform-backend-gaps, docs/implementation-notes.md):
 *
 * | # | Route | What |
 * |---|---|---|
 * | 3  | `GET /platform` | `accountId` complete for L only; A / O get `••••<last 4>` |
 * | 7  | `PATCH /settings`, KEEP quotes | `cost.highHourlyThreshold`; KEEP quotes return `requiresTypedConfirm` |
 * | 11 | `GET …/runner-runs`, `…/runner-runs/{runId}/log` | RunnerRun list; redacted progress / result from `atl-data/runs/<runId>/` |
 * | 12 | `GET …/report?version=&view=full` | a given version; `view=full` returns the stored `atl.report/v1` JSON as is; `versions[]` |
 * | 13 | `GET …/check-runs/{runId}/evidence/{checkKey}` | same-origin read of evidence stored in `atl-data/evidence/` |
 * | 16 | `GET /platform/exports/{exportId}` | export status and download link |
 * | 18 | `GET /manual-confirmations?status=pending` | assistant review queue (AP20 `REVIEW#PENDING`) |
 * | 22 | `GET …/events?after=` | `410 CURSOR_EXPIRED` for a cursor that cannot belong to this session's stream |
 * | 25 | `POST …/steps/{stepId}/outage` | opens the step's expected-outage window (atl-lifecycle `OpenOutageWindow`) |
 * | 28 | `GET /environments/{envId}/resources?state=` | reclaim ledger of the whole hand-over chain |
 * | —  | `GET /resources/manual` | items carry `labId` and the session's times (web scaffold request) |
 */
import { AtlError, DataKeys, isEnvId, isSid, parseRunnerRunId, ULID_RE, type SessionState } from '@atl/shared';
import { Keys, SkPrefix } from '../data/keys.js';
import { accepted, ok } from '../http/responses.js';
import type { RouteHandler, RouteHandlers } from '../http/router.js';
import type { HttpResult } from '../http/types.js';
import { parseBody, z } from '../http/validate.js';
import { stripKeys, type Item, type SessionItem } from '../repositories/index.js';
import { maskDeep, redactEvidence } from '../functions/checks/engine/redact.js';
import { resourceView } from '../services/sessions/cleanup.js';
import { mapDownstreamError } from '../services/sessions/lifecycle-client.js';
import { loadSession, platformConfig, principalOf, requireState, type ApiContext } from './context.js';
import type { ApiExtensions } from './extensions.js';
import { wrap } from './platform.js';

const LINK_SECONDS = 900;
const LIVE: readonly SessionState[] = ['READY', 'RUNNING', 'EXPIRING'];
/** A client clock may run ahead; cursors (event ULIDs) newer than this are not of this stream. */
const CURSOR_FUTURE_MS = 10 * 60_000;
const MAX_LOG_LINES = 200;

function bodyOf(r: HttpResult): Record<string, unknown> | null {
  try {
    return r.body ? (JSON.parse(r.body) as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function withBody(r: HttpResult, body: unknown): HttpResult {
  return { ...r, body: JSON.stringify(body) };
}

async function presignGet(ctx: ApiContext, key: string): Promise<{ url: string; expiresAt: string }> {
  const url = await ctx.deps.ports.objects.presign(ctx.deps.env.buckets.data, key, { method: 'GET', expiresInSeconds: LINK_SECONDS });
  return { url, expiresAt: new Date(ctx.nowMs + LINK_SECONDS * 1000).toISOString() };
}

async function readText(ctx: ApiContext, key: string): Promise<string | null> {
  const b = await ctx.deps.ports.objects.get(ctx.deps.env.buckets.data, key);
  return b ? Buffer.from(b).toString('utf8') : null;
}

function ulidTimeMs(id: string): number {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let t = 0;
  for (const ch of id.slice(0, 10).toUpperCase()) t = t * 32 + alphabet.indexOf(ch);
  return t;
}

function chainOf(env: Item): string[] {
  return Array.isArray(env.sessionChain) ? (env.sessionChain as unknown[]).filter((x): x is string => typeof x === 'string') : [];
}

/** `••••<last 4>` (08 §3.5, §9.2 #3). */
export function maskAccountId(id: string): string {
  return `••••${id.slice(-4)}`;
}

/** Secrets (by key) and account IDs / public IPs (by pattern) removed from runner output (08 §9.2 #11, #33). */
function scrub<T>(v: T): T {
  return maskDeep(redactEvidence(v).value);
}

async function reportVersions(ctx: ApiContext, sid: string): Promise<Item[]> {
  return (await ctx.repos.sessions.children(sid, SkPrefix.report, { all: true })).items.sort((x, y) => Number(y.version ?? 0) - Number(x.version ?? 0));
}

function versionsView(all: Item[]): Record<string, unknown>[] {
  return all.map((r) => ({ version: r.version ?? null, generatedAt: r.generatedAt ?? null, status: r.status ?? null, digest: r.digest ?? null }));
}

/** Handlers of the 08 §9.2 routes; `base` are the handlers they refine (same route ids). */
export function gapRoutes(ext: ApiExtensions, base: RouteHandlers): RouteHandlers {
  const baseOf = (id: keyof RouteHandlers): RouteHandler => {
    const h = base[id];
    if (!h) throw new Error(`gapRoutes: base handler ${String(id)} is missing`);
    return h;
  };
  const getPlatform = baseOf('getPlatform');
  const getReport = baseOf('getReport');
  const listSessionEvents = baseOf('listSessionEvents');
  const listManualResources = baseOf('listManualResources');
  const createSessionQuote = baseOf('createSessionQuote');

  return {
    // #3 ---------------------------------------------------------------------------------------------------------
    getPlatform: async (req) => {
      const r = await getPlatform(req);
      const b = r.statusCode === 200 ? bodyOf(r) : null;
      if (!b || typeof b.accountId !== 'string') return r;
      const learner = !!req.principal?.groups.includes('learner');
      return withBody(r, { ...b, accountId: learner ? b.accountId : maskAccountId(b.accountId), accountIdMasked: !learner });
    },

    // #7 ---------------------------------------------------------------------------------------------------------
    createSessionQuote: async (req) => {
      const r = await createSessionQuote(req);
      const b = r.statusCode < 300 ? bodyOf(r) : null;
      if (!b || b.purpose !== 'KEEP') return r;
      const cfg = await wrapCtx(ext, req, platformConfig);
      const threshold = (cfg?.cost as { highHourlyThreshold?: unknown } | undefined)?.highHourlyThreshold;
      const t = typeof threshold === 'number' && threshold > 0 ? threshold : null;
      const hourly = typeof b.retainHourly === 'number' ? b.retainHourly : null;
      const incomplete = Array.isArray(b.incomplete) && b.incomplete.length > 0;
      // unknown or incomplete estimates cannot prove they stay below the threshold (fail safe)
      const requiresTypedConfirm = t !== null && (hourly === null || incomplete || hourly > t);
      return withBody(r, { ...b, highHourlyThreshold: t, requiresTypedConfirm, ...(requiresTypedConfirm ? { typedConfirmValue: b.labId ?? null } : {}) });
    },

    // #11 --------------------------------------------------------------------------------------------------------
    listRunnerRuns: wrap(ext, async (ctx) => {
      const s = await loadSession(ctx, ctx.req.params.sid);
      const items = (await ctx.repos.sessions.children(s.sid, SkPrefix.runnerRun, { all: true })).items;
      return ok({
        sessionId: s.sid,
        items: items
          .map((i) => {
            const { resultKey: _k, ...rest } = stripKeys(i);
            return scrub(rest);
          })
          .sort((a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? ''))),
      });
    }),

    getRunnerRunLog: wrap(ext, async (ctx) => {
      const s = await loadSession(ctx, ctx.req.params.sid);
      const runId = ctx.req.params.runId ?? '';
      const parsed = parseRunnerRunId(runId);
      if (!parsed || parsed.sid !== s.sid) throw new AtlError('NOT_FOUND', 'runner run not found');
      const run = await ctx.repos.sessions.getChild(Keys.runnerRun(s.sid, runId));
      const prefix = DataKeys.run(runId);
      const [resultText, progressText] = await Promise.all([readText(ctx, `${prefix}result.json`), readText(ctx, `${prefix}progress.jsonl`)]);
      if (!run && resultText === null && progressText === null) throw new AtlError('NOT_FOUND', `runner run ${runId} not found`);
      let result: unknown = null;
      try {
        result = resultText ? JSON.parse(resultText) : null;
      } catch {
        result = null;
      }
      const lines = (progressText ?? '')
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => {
          try {
            return JSON.parse(l) as unknown;
          } catch {
            return { text: l.slice(0, 500) };
          }
        });
      return ok({
        sessionId: s.sid,
        runId,
        op: run?.op ?? parsed.op ?? null,
        status: run?.status ?? ((result as { ok?: boolean } | null)?.ok === true ? 'SUCCEEDED' : (result as { ok?: boolean } | null)?.ok === false ? 'FAILED' : null),
        result: result ? scrub(result) : null,
        progress: scrub(lines.slice(-MAX_LOG_LINES)),
        truncated: lines.length > MAX_LOG_LINES,
        source: `atl-data/${prefix}`,
      });
    }),

    // #12 --------------------------------------------------------------------------------------------------------
    getReport: async (req) => {
      const version = req.query.version;
      const view = req.query.view;
      if (version === undefined && view === undefined) {
        const r = await getReport(req);
        const b = r.statusCode === 200 ? bodyOf(r) : null;
        return b ? withBody(r, { ...b, versions: b.revisions ?? [] }) : r;
      }
      return wrap(ext, async (ctx) => {
        if (view !== undefined && view !== 'full') throw new AtlError('VALIDATION_FAILED', 'view must be full');
        if (version !== undefined && !/^[1-9]\d{0,4}$/.test(version)) throw new AtlError('VALIDATION_FAILED', 'version must be a positive integer');
        const s = await loadSession(ctx, ctx.req.params.sid);
        const all = await reportVersions(ctx, s.sid);
        const item = version === undefined ? all[0] : all.find((r) => Number(r.version) === Number(version));
        if (!item) throw new AtlError('NOT_FOUND', version === undefined ? `session ${s.sid} has no report yet` : `report version ${version} not found`);
        const keys = (item.s3Keys ?? {}) as { json?: string; html?: string };
        if (view === 'full') {
          const text = keys.json ? await readText(ctx, keys.json) : null;
          if (text === null) throw new AtlError('NOT_FOUND', 'the report JSON of this version is not stored');
          // the authoritative JSON exactly as stored (verification of `reportDigest`, 08 P09-C)
          return {
            statusCode: 200,
            headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, no-cache', 'x-atl-report-version': String(item.version ?? ''), ...(typeof item.digest === 'string' ? { 'x-atl-report-digest': item.digest } : {}) },
            body: text,
          };
        }
        return ok({
          ...stripKeys(item),
          downloads: { json: keys.json ? await presignGet(ctx, keys.json) : null, html: keys.html ? await presignGet(ctx, keys.html) : null },
          versions: versionsView(all),
          revisions: versionsView(all),
          latest: Number(item.version) === Number(all[0]?.version),
        });
      })(req);
    },

    // #13 --------------------------------------------------------------------------------------------------------
    getCheckEvidence: wrap(ext, async (ctx) => {
      const s = await loadSession(ctx, ctx.req.params.sid);
      const runId = ctx.req.params.runId ?? '';
      const checkKey = ctx.req.params.checkKey ?? '';
      if (!ULID_RE.test(runId) || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(checkKey) || checkKey.includes('..')) throw new AtlError('NOT_FOUND', 'evidence not found');
      const run = await ctx.repos.sessions.getChild(Keys.checkRun(s.sid, runId));
      const item = ((run?.results ?? []) as { checkKey?: string; evidence?: unknown; evidenceKey?: string; evidenceDigest?: string }[]).find((x) => x.checkKey === checkKey);
      if (!item) throw new AtlError('NOT_FOUND', 'evidence not found');
      let evidence: unknown = item.evidence ?? null;
      let stored = false;
      if (!evidence && item.evidenceKey) {
        // the key must be this session / run / check (never follow a key elsewhere in atl-data)
        if (item.evidenceKey !== DataKeys.evidence(s.sid, runId, checkKey)) throw new AtlError('NOT_FOUND', 'evidence not found');
        const text = await readText(ctx, item.evidenceKey);
        if (text === null) throw new AtlError('NOT_FOUND', 'the stored evidence object is missing');
        evidence = JSON.parse(text) as unknown;
        stored = true;
      }
      if (!evidence) throw new AtlError('NOT_FOUND', 'this check result has no evidence');
      return ok({ sessionId: s.sid, runId, checkKey, digest: item.evidenceDigest ?? null, stored, evidence }, { 'cache-control': 'private, max-age=3600, immutable' });
    }),

    // #16 --------------------------------------------------------------------------------------------------------
    getPlatformExport: wrap(ext, async (ctx) => {
      const exportId = ctx.req.params.exportId ?? '';
      if (!/^[0-9a-f]{26}$/.test(exportId)) throw new AtlError('NOT_FOUND', 'export not found');
      const key = `${DataKeys.exports}${exportId}.zip`;
      const exists = await ctx.deps.ports.objects.get(ctx.deps.env.buckets.data, key);
      if (!exists) return ok({ exportId, status: 'pending', retryAfterSeconds: 10 });
      const link = await presignGet(ctx, key);
      return ok({ exportId, status: 'ready', downloadUrl: link.url, expiresAt: link.expiresAt });
    }),

    // #18 --------------------------------------------------------------------------------------------------------
    listManualConfirmations: wrap(ext, async (ctx) => {
      const status = ctx.req.query.status ?? 'pending';
      if (status !== 'pending') throw new AtlError('VALIDATION_FAILED', 'status must be pending (AP20 only indexes pending reviews)');
      const items = await ctx.repos.table.queryAll({ index: 'GSI2', pk: 'REVIEW#PENDING' }, 500);
      const sessions = new Map<string, SessionItem | null>();
      for (const sid of new Set(items.map((i) => String(i.sessionId ?? String(i.GSI2SK ?? '').split('#').pop())))) {
        sessions.set(sid, isSid(sid) ? await ctx.repos.sessions.get(sid, false) : null);
      }
      return ok({
        status,
        items: items.map((i) => {
          const sid = String(i.sessionId ?? String(i.GSI2SK ?? '').split('#').pop());
          const s = sessions.get(sid);
          const { GSI2PK: _a, GSI2SK: _b, ...rest } = stripKeys(i);
          return { ...rest, sessionId: sid, labId: s?.labId ?? null, sessionState: s?.state ?? null };
        }),
      });
    }),

    // #22 --------------------------------------------------------------------------------------------------------
    listSessionEvents: async (req) => {
      const after = req.query.after;
      if (after && ULID_RE.test(after)) {
        const r = await wrap(ext, async (ctx) => {
          const s = await loadSession(ctx, ctx.req.params.sid);
          const t = ulidTimeMs(after);
          const created = Date.parse(String(s.createdAt ?? ''));
          if (t > ctx.nowMs + CURSOR_FUTURE_MS || (Number.isFinite(created) && t < created - 24 * 3_600_000)) {
            throw new AtlError('CURSOR_EXPIRED', 'the cursor does not belong to this session’s event stream; drop it and read from the start');
          }
          return ok(null);
        })(req);
        if (r.statusCode !== 200) return r;
      }
      return listSessionEvents(req);
    },

    // #25 --------------------------------------------------------------------------------------------------------
    openStepOutage: wrap(ext, async (ctx) => {
      const s = await loadSession(ctx, ctx.req.params.sid);
      parseBody(z.object({}).strict(), ctx.req.body ?? {});
      requireState(s, LIVE, 'an expected-outage window');
      const stepId = ctx.req.params.stepId ?? '';
      const lab = typeof s.catalogVersion === 'string' ? await ctx.catalog.lab(s.labId, s.catalogVersion) : null;
      const step = (lab?.steps ?? []).find((x) => x.id === stepId);
      if (!step) throw new AtlError('NOT_FOUND', `step ${stepId} not found`);
      const eo = step.expectedOutage;
      if (!eo) throw new AtlError('VALIDATION_FAILED', `step ${stepId} declares no expected outage`, { reason: 'NO_EXPECTED_OUTAGE' });
      let r: { outageWindow?: unknown } | null;
      try {
        r = await ctx.deps.ports.invoker.invoke<{ outageWindow?: unknown } | null>('atl-lifecycle', {
          action: 'OpenOutageWindow',
          sessionId: s.sid,
          channel: eo.channel,
          maxMinutes: eo.maxMinutes,
          reason: eo.reason,
          stepId,
          requestedBy: principalOf(ctx).sub,
        });
      } catch (e) {
        mapDownstreamError(e, 'atl-lifecycle OpenOutageWindow');
      }
      return accepted({ sessionId: s.sid, stepId, outageWindow: r?.outageWindow ?? null });
    }),

    // #28 --------------------------------------------------------------------------------------------------------
    listEnvironmentResources: wrap(ext, async (ctx) => {
      const envId = ctx.req.params.envId ?? '';
      if (!isEnvId(envId)) throw new AtlError('NOT_FOUND', 'environment not found');
      const env = await ctx.repos.environments.get(envId);
      if (!env) throw new AtlError('NOT_FOUND', `environment ${envId} not found`);
      const p = principalOf(ctx);
      if (p.groups.includes('learner')) {
        const owners = await Promise.all(chainOf(env).map((sid) => ctx.repos.sessions.get(sid, false)));
        if (owners.length && !owners.some((s) => s?.sub === p.sub)) throw new AtlError('NOT_FOUND', `environment ${envId} not found`);
      }
      const states = (ctx.req.query.state ?? '').split(',').map((x) => x.trim()).filter(Boolean);
      const ledger = await ctx.repos.environments.resources(envId);
      const items = ledger.filter((r) => !states.length || states.includes(String(r.cleanupState))).map((r) => ({ ...resourceView(r), envId }));
      return ok({ envId, envName: env.envName, sessionChain: chainOf(env), items, total: items.length, countedBy: 'environment' });
    }),

    // web scaffold request: manual items name the card and the session's times ----------------------------------
    listManualResources: async (req) => {
      const r = await listManualResources(req);
      const b = r.statusCode === 200 ? bodyOf(r) : null;
      if (!b || !Array.isArray(b.items)) return r;
      return wrap(ext, async (ctx) => {
        const items = b.items as Record<string, unknown>[];
        const sids = [...new Set(items.map((i) => i.sessionId).filter((x): x is string => typeof x === 'string' && isSid(x)))];
        const sessions = new Map((await Promise.all(sids.map((sid) => ctx.repos.sessions.get(sid, false)))).filter((s): s is SessionItem => !!s).map((s) => [s.sid, s]));
        return ok({
          ...b,
          items: items.map((i) => {
            const s = typeof i.sessionId === 'string' ? sessions.get(i.sessionId) : undefined;
            return { ...i, labId: s?.labId ?? null, sessionCreatedAt: s?.createdAt ?? null, sessionEndedAt: (s?.endedAt as string | undefined) ?? null, sessionState: s?.state ?? null };
          }),
        });
      })(req);
    },
  };
}

/** Run a context-needing helper for a raw route request. */
async function wrapCtx<T>(ext: ApiExtensions, req: Parameters<RouteHandler>[0], f: (ctx: ApiContext) => Promise<T>): Promise<T> {
  let out!: T;
  await wrap(ext, async (ctx) => {
    out = await f(ctx);
    return ok(null);
  })(req);
  return out;
}
