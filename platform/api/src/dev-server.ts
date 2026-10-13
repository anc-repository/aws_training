/**
 * Local dev server for front-end development and end-to-end tests (ATL_DEV_MODE=1 only, never deployed):
 * Express adapts HTTP requests to the API Gateway payload-2.0 events of the three HTTP functions (atl-api, atl-agent,
 * atl-public) running in the in-process dev runtime (DynamoDB Local, simulated Step Functions, dev tokens, …).
 *
 *   npx tsx platform/api/src/dev-server.ts --dev-mode [--seed-catalog <labs dir>] [--port 8788]
 *
 *   Browser routes   Authorization: Bearer dev.<learner|assistant|observer>.<sub>
 *   Agent routes     X-ATL-Dev-Caller: arn:aws:sts::000000000000:assumed-role/ATLLearnerRole/atl-<sid>-ws
 *   Internal routes  X-ATL-Dev-Caller: arn:aws:sts::000000000000:assumed-role/ATLProvisionerRole/atl-<sid>-prov-<op>
 *   /content/*       the dev `atl-web` bucket (what CloudFront serves in production)
 *   /__dev/*         the scaffold's control endpoints (clock, faults, trail, invoke) plus
 *                    POST /__dev/sessions/<sid>/advance { to, minutes? } — move a session along the state machine while
 *                    the real lifecycle workflows are not available (dev only)
 *
 * Until `atl-lifecycle` implements them, `CreateSession`, `Transition`, `Extend` and `ExtendKeep` fall back to a dev
 * implementation on the shared repositories (`devLifecycleFallback`), so that the browser flows can be exercised.
 */
import fs from 'node:fs';
import type http from 'node:http';
import path from 'node:path';
import express from 'express';
import { parse as parseYaml } from 'yaml';
import {
  canTransition,
  ceilToMinute,
  envNameFromEnvId,
  Gsi1,
  Gsi2,
  INSTALL_DEFAULTS,
  isSessionState,
  Keys,
  matchRoute,
  newEnvId,
  stateUri,
  TAG_KEYS,
  WebKeys,
  type LambdaFunctionName,
  type SessionState,
} from '@atl/shared';
import type { HttpEvent, HttpResult } from './http/types.js';
import { createRepositories, isConditionFailed, type Item, type Repositories, type SessionItem } from './repositories/index.js';
import { createAgentHttpHandler, createApiHttpHandler, createPublicHttpHandler, type ApiExtensions } from './routes/index.js';
import type { DepsProvider, FunctionDeps } from './runtime/deps.js';
import { clearContentCache } from './services/catalog/store.js';
// Dev-only entry point, never bundled into a Lambda (build.mjs bundles functions/*/index.ts). The dev runtime is
// imported lazily so that tests can use the adapter and the lifecycle fallback without loading every function.
// eslint-disable-next-line no-restricted-imports -- type only
import type { DevRuntime } from './dev/runtime.js';

const loadDevRuntime = () => import('./dev/runtime.js');
const loadDevServer = () => import('./dev/server.js');
const loadDevTables = () => import('./dev/create-tables.js');
const loadDevConfigModule = () => import('./dev/config.js');

type InProcessFn = (payload: unknown) => Promise<unknown>;

// ---------------------------------------------------------------------------------------------------------------
// Lambda adapter

const AGENT_PREFIXES = ['/api/v1/agent/', '/api/v1/internal/', '/api/v1/agent-fallback/'];

export function functionForPath(method: string, p: string): LambdaFunctionName {
  const m = matchRoute(method, p);
  if (m) return m.route.fn;
  if (AGENT_PREFIXES.some((x) => p.startsWith(x))) return 'atl-agent';
  if (p.startsWith('/api/v1/public/')) return 'atl-public';
  return 'atl-api';
}

/** Express request → API Gateway HTTP API payload 2.0 (what the Lambda handlers receive). */
export function toHttpEvent(req: express.Request, body: Buffer | undefined, accountId: string): HttpEvent {
  const url = new URL(req.originalUrl, 'http://localhost');
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers[k] = v;
  const caller = headers['x-atl-dev-caller'];
  const text = body && body.length ? body.toString('utf8') : undefined;
  return {
    version: '2.0',
    rawPath: url.pathname,
    rawQueryString: url.search.slice(1),
    headers,
    queryStringParameters: Object.fromEntries(url.searchParams.entries()),
    ...(text !== undefined ? { body: text } : {}),
    isBase64Encoded: false,
    requestContext: {
      requestId: globalThis.crypto.randomUUID(),
      http: { method: req.method.toUpperCase(), path: url.pathname, sourceIp: req.ip ?? '127.0.0.1', userAgent: headers['user-agent'] ?? '' },
      ...(caller ? { authorizer: { iam: { userArn: caller, accountId } } } : {}),
    },
  };
}

function sendResult(res: express.Response, r: HttpResult): void {
  res.status(r.statusCode);
  for (const [k, v] of Object.entries(r.headers ?? {})) res.setHeader(k, v);
  res.end(r.isBase64Encoded && r.body ? Buffer.from(r.body, 'base64') : (r.body ?? ''));
}

const DEV_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

function cors(req: express.Request, res: express.Response): void {
  const origin = req.headers.origin;
  if (!origin || !DEV_ORIGIN.test(origin)) return;
  res.setHeader('access-control-allow-origin', origin);
  res.setHeader('vary', 'origin');
  res.setHeader('access-control-allow-headers', 'authorization, content-type, idempotency-key, if-match, if-none-match, x-atl-dev-caller, x-atl-run-token');
  res.setHeader('access-control-allow-methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('access-control-expose-headers', 'etag, location, retry-after, idempotent-replayed');
}

export interface DevAppOptions {
  ext?: ApiExtensions;
  /** Serve `/__dev/*` (default true). */
  controlEndpoints?: boolean;
}

/** Register the API's HTTP functions in the runtime (replacing the scaffold stubs) and the lifecycle fallback. */
export function installApiFunctions(rt: Pick<DevRuntime, 'invoker' | 'deps' | 'functions'>, ext: ApiExtensions = {}): void {
  const getDeps: DepsProvider = async () => rt.deps;
  const api = createApiHttpHandler(getDeps, ext);
  const agent = createAgentHttpHandler(getDeps, ext);
  const pub = createPublicHttpHandler(getDeps, ext);
  rt.invoker.register('atl-api', (e) => api(e as HttpEvent));
  rt.invoker.register('atl-agent', (e) => agent(e as HttpEvent));
  rt.invoker.register('atl-public', (e) => pub(e as HttpEvent));
  rt.invoker.register('atl-lifecycle', withDevLifecycleFallback(rt.functions['atl-lifecycle'], getDeps));
}

export function createDevApp(rt: DevRuntime, opts: DevAppOptions = {}): express.Express {
  installApiFunctions(rt, opts.ext);
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);
  if (opts.controlEndpoints !== false) {
    app.post('/__dev/sessions/:sid/advance', express.json(), (req, res) => {
      const body = (req.body ?? {}) as { to?: string; minutes?: number };
      devAdvance(rt.deps, String(req.params.sid), String(body.to ?? ''), body.minutes)
        .then((s) => res.json({ sessionId: s.sid, state: s.state, ver: s.ver, deadlineAt: s.deadlineAt ?? null, envId: s.envId ?? null }))
        .catch((e: unknown) => res.status(409).json({ error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) }));
    });
    app.post('/__dev/catalog/seed', express.json(), (req, res) => {
      const dir = String((req.body as { labsDir?: string } | undefined)?.labsDir ?? path.join(process.cwd(), 'labs'));
      seedDevCatalog(rt.deps, dir)
        .then((r) => res.json(r))
        .catch((e: unknown) => res.status(500).json({ error: String(e) }));
    });
    app.all(/^\/__dev\//, (req, res) => {
      req.url = req.originalUrl;
      loadDevServer()
        .then(({ handleDevRequest }) => handleDevRequest(rt, req as unknown as http.IncomingMessage, res))
        .catch((e: unknown) => res.status(500).json({ error: String(e) }));
    });
  }
  app.get(/^\/content\//, (req, res) => {
    const key = decodeURIComponent(new URL(req.originalUrl, 'http://x').pathname).slice(1);
    rt.objects
      .get(rt.env.buckets.web, key)
      .then((b) => {
        if (!b) return res.status(404).end();
        res.setHeader('content-type', key.endsWith('.json') ? 'application/json; charset=utf-8' : 'application/octet-stream');
        return res.end(Buffer.from(b));
      })
      .catch(() => res.status(400).end());
  });
  app.options(/^\/api\//, (req, res) => {
    cors(req, res);
    res.status(204).end();
  });
  app.all(/^\/api\//, express.raw({ type: () => true, limit: '2mb' }), (req, res) => {
    cors(req, res);
    const event = toHttpEvent(req, Buffer.isBuffer(req.body) ? req.body : undefined, rt.env.accountId);
    rt.invoker
      .invoke<HttpResult>(functionForPath(event.requestContext.http.method, event.rawPath), event)
      .then((r) => sendResult(res, r))
      .catch((e: unknown) => res.status(500).json({ error: String(e) }));
  });
  return app;
}

// ---------------------------------------------------------------------------------------------------------------
// Dev fallback of the API-facing lifecycle actions (used only while atl-lifecycle answers Atl.NotImplemented)

const iso = (ms: number) => new Date(ms).toISOString();

export function withDevLifecycleFallback(real: InProcessFn, getDeps: DepsProvider): InProcessFn {
  return async (payload) => {
    try {
      return await real(payload);
    } catch (e) {
      const action = (payload as { action?: string } | null)?.action ?? '';
      const fb = DEV_LIFECYCLE_ACTIONS[action];
      if ((e as { name?: string } | null)?.name !== 'Atl.NotImplemented' || !fb) throw e;
      return fb(payload as Record<string, unknown>, await getDeps());
    }
  };
}

function reposOf(deps: FunctionDeps): Repositories {
  return createRepositories(deps.db, deps.env.tableName);
}

async function updateCountdown(repos: Repositories, s: SessionItem, set: Record<string, unknown>, nowMs: number): Promise<SessionItem> {
  const next = { ...s, ...set } as SessionItem;
  const gsi2 = Gsi2.labSession({ sid: s.sid, state: s.state, stateEnteredAt: s.stateEnteredAt, deadlineAt: (next.deadlineAt as string) ?? null });
  return repos.table.update<SessionItem>(Keys.labSession(s.sid), {
    set: { ...set, ...(gsi2 ?? {}), ver: s.ver + 1, updatedAt: iso(nowMs) },
    condition: { expression: '#v = :v AND #s = :s', names: { '#v': 'ver', '#s': 'state' }, values: { ':v': s.ver, ':s': s.state } },
  });
}

export const DEV_LIFECYCLE_ACTIONS: Record<string, (p: Record<string, unknown>, deps: FunctionDeps) => Promise<unknown>> = {
  async CreateSession(p, deps) {
    const repos = reposOf(deps);
    const draft = p.session as Item & { sid: string; sub: string; labId: string; variant: string };
    const s = await repos.sessions.createRequested(draft, deps.ports.clock.nowMs());
    return { sessionId: s.sid, state: s.state, ver: s.ver };
  },

  async Transition(p, deps) {
    const repos = reposOf(deps);
    const nowMs = deps.ports.clock.nowMs();
    const to = String(p.to) as SessionState;
    const set: Record<string, unknown> = {};
    if (to === 'RUNNING') set.runningAt = iso(nowMs);
    if (to === 'ENDED' || to === 'FAILED') Object.assign(set, { endedAt: iso(nowMs), endReason: p.reason });
    const r = await repos.sessions.transition({
      sid: String(p.sessionId),
      from: (p.from as SessionState[]) ?? [],
      to,
      reason: String(p.reason),
      nowMs,
      set,
      ...(typeof p.expectedVer === 'number' ? { expectedVer: p.expectedVer } : {}),
    });
    return r.session;
  },

  async Extend(p, deps) {
    const repos = reposOf(deps);
    const nowMs = deps.ports.clock.nowMs();
    const s = await repos.sessions.get(String(p.sessionId));
    if (!s || !['READY', 'RUNNING', 'EXPIRING'].includes(s.state)) throw named('Atl.SessionExpiringOrEnded', 'not extendable');
    if (s.deadlineVersion !== p.expectedDeadlineVersion) throw named('Atl.PreconditionFailed', 'deadlineVersion changed');
    const deadline = Date.parse(String(s.deadlineAt)) + Number(p.minutes) * 60_000;
    const set = {
      deadlineAt: iso(deadline),
      deadlineVersion: Number(s.deadlineVersion ?? 1) + 1,
      extensions: [...((s.extensions as unknown[]) ?? []), { at: iso(nowMs), minutes: p.minutes, quoteId: p.quoteId, actor: 'user' }],
    };
    if (s.state === 'EXPIRING' && deadline - nowMs > 15 * 60_000) {
      return (await repos.sessions.transition({ sid: s.sid, from: ['EXPIRING'], to: s.runningAt ? 'RUNNING' : 'READY', reason: 'EXTENDED', nowMs, set, events: [{ type: 'session.extended', data: { minutes: p.minutes, deadlineAt: set.deadlineAt, deadlineVersion: set.deadlineVersion } }] })).session;
    }
    const u = await updateCountdown(repos, s, set, nowMs);
    await repos.events.append(s.sid, [{ type: 'session.extended', data: { minutes: p.minutes, deadlineAt: set.deadlineAt, deadlineVersion: set.deadlineVersion } }], nowMs);
    return u;
  },

  async ExtendKeep(p, deps) {
    const repos = reposOf(deps);
    const nowMs = deps.ports.clock.nowMs();
    const s = await repos.sessions.get(String(p.sessionId));
    if (!s || s.state !== 'KEPT') throw named('Atl.TransitionRejected', 'not kept');
    const keep = (s.keep ?? {}) as { until?: string; version?: number };
    const until = iso(Date.parse(keep.until ?? iso(nowMs)) + Number(p.hours) * 3_600_000);
    const r = await repos.sessions.transition({
      sid: s.sid,
      from: ['KEPT'],
      to: 'KEPT',
      reason: `KEEP_EXTENDED_${(keep.version ?? 1) + 1}`,
      nowMs,
      set: { keep: { ...keep, until, version: (keep.version ?? 1) + 1, quoteId: p.quoteId } },
      events: [{ type: 'session.keep_extended', data: { keepUntil: until } }],
    });
    return r.session;
  },
};

function named(name: string, message: string): Error {
  const e = new Error(message);
  e.name = name;
  return e;
}

/**
 * Dev control: move a session along T01–T21 without the workflows. Fills the time fields the views need
 * (`readyAt`, `deadlineAt`, `envId` with a dev `Environment`, lock holder).
 */
export async function devAdvance(deps: FunctionDeps, sid: string, toRaw: string, minutes?: number): Promise<SessionItem> {
  if (!isSessionState(toRaw)) throw new Error(`unknown state ${toRaw}`);
  const to: SessionState = toRaw;
  const repos = reposOf(deps);
  const nowMs = deps.ports.clock.nowMs();
  const s = await repos.sessions.get(sid);
  if (!s) throw new Error(`session ${sid} not found`);
  if (!canTransition(s.state, to)) throw new Error(`${s.state} → ${to} is not a transition of 02 §2.3`);
  const set: Record<string, unknown> = {};
  if (to === 'PROVISIONING') {
    const envId = typeof s.envId === 'string' ? s.envId : newEnvId(nowMs);
    set.envId = envId;
    await ensureDevEnvironment(repos, deps, envId, s, nowMs);
    await repos.platform.acquire(sid, envId, iso(nowMs)).catch(() => undefined);
  }
  if (to === 'READY') {
    const limit = minutes ?? Number((s.cardLimits as { timeLimitMinutes?: number } | undefined)?.timeLimitMinutes ?? 60);
    Object.assign(set, { readyAt: iso(nowMs), deadlineAt: iso(ceilToMinute(nowMs + limit * 60_000)), deadlineVersion: 1, extensions: [] });
  }
  if (to === 'RUNNING') set.runningAt = iso(nowMs);
  if (to === 'ENDING') set.revokedAt = iso(nowMs);
  if (to === 'KEPT') set.keep = { until: iso(nowMs + (minutes ?? 60) * 60_000), version: 1, saveMode: true, confirmedAt: iso(nowMs), quoteId: 'dev' };
  if (to === 'ENDED' || to === 'FAILED') {
    Object.assign(set, { endedAt: iso(nowMs) });
    await repos.platform.release(sid, iso(nowMs));
  }
  return (await repos.sessions.transition({ sid, from: [s.state], to, reason: 'DEV_ADVANCE', nowMs, set })).session;
}

async function ensureDevEnvironment(repos: Repositories, deps: FunctionDeps, envId: string, s: SessionItem, nowMs: number): Promise<void> {
  if (await repos.environments.get(envId)) return;
  const envName = envNameFromEnvId(envId);
  const createdAt = iso(nowMs);
  try {
    await repos.table.put(
      {
        ...Keys.environment(envId),
        ...Gsi1.environment(createdAt, envId),
        ...(Gsi2.environment('ACTIVE', envId, createdAt) ?? {}),
        type: 'Environment',
        ver: 1,
        createdAt,
        updatedAt: createdAt,
        envId,
        envName,
        status: 'ACTIVE',
        ownerSessionId: s.sid,
        sessionChain: [s.sid],
        labChain: [s.labId],
        enabledModules: [],
        stateUri: stateUri(deps.env.accountId, deps.env.region, envName),
        stacks: [],
        instances: [],
        endpoints: { baseUrl: 'http://127.0.0.1:8080', https: { trusted: false } },
        maxAgeUntil: iso(nowMs + INSTALL_DEFAULTS.EnvMaxAgeDays * 86_400_000),
        platformTags: { [TAG_KEYS.component]: 'env', [TAG_KEYS.envId]: envId, [TAG_KEYS.project]: 'CloudAlbum' },
      },
      { expression: 'attribute_not_exists(PK)' },
    );
  } catch (e) {
    if (!isConditionFailed(e)) throw e;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Dev content release from labs/ (lab.yaml v2 → content/dev/…; 04 §2.5, 05 §8.4)

export const DEV_CATALOG_VERSION = 'dev';

function readYaml(file: string): unknown {
  return parseYaml(fs.readFileSync(file, 'utf8'));
}

export async function seedDevCatalog(deps: FunctionDeps, labsDir: string, catalogVersion = DEV_CATALOG_VERSION): Promise<{ catalogVersion: string; cards: string[]; tracks: string[] }> {
  if (!fs.existsSync(labsDir)) return { catalogVersion, cards: [], tracks: [] };
  const web = deps.env.buckets.web;
  const prefix = WebKeys.content(catalogVersion);
  const cards: Record<string, unknown>[] = [];
  for (const d of fs.readdirSync(labsDir, { withFileTypes: true })) {
    const file = path.join(labsDir, d.name, 'lab.yaml');
    if (!d.isDirectory() || d.name.startsWith('_') || !fs.existsSync(file)) continue;
    const lab = readYaml(file) as Record<string, unknown> & { id: string };
    await deps.ports.objects.put(web, `${prefix}labs/${lab.id}.json`, JSON.stringify(lab), { contentType: 'application/json' });
    const quizFile = path.join(labsDir, d.name, 'quiz.yaml');
    if (fs.existsSync(quizFile)) {
      await deps.ports.objects.put(deps.env.buckets.artifacts, `releases/${catalogVersion}/private/quiz/${lab.id}.json`, JSON.stringify(readYaml(quizFile)), { contentType: 'application/json' });
    }
    const cost = (lab.cost ?? {}) as { tier?: string; tierWithOptional?: string };
    cards.push({
      id: lab.id,
      kind: lab.kind,
      version: lab.version,
      status: lab.status ?? 'stable',
      title: lab.title,
      subtitle: lab.subtitle ?? null,
      summary: lab.summary,
      difficulty: lab.difficulty,
      estimatedMinutes: lab.estimatedMinutes,
      timeLimitMinutes: lab.timeLimitMinutes,
      costTier: { required: cost.tier ?? null, withOptional: cost.tierWithOptional ?? cost.tier ?? null },
      services: lab.services ?? [],
      tracks: lab.tracks ?? [],
    });
  }
  const tracksDir = path.join(labsDir, '_tracks');
  const tracks = fs.existsSync(tracksDir)
    ? fs.readdirSync(tracksDir).filter((f) => f.endsWith('.yaml')).map((f) => readYaml(path.join(tracksDir, f)) as Record<string, unknown>)
    : [];
  const catalogFile = path.join(labsDir, '_catalog', 'catalog.yaml');
  const generated = fs.existsSync(catalogFile) ? (readYaml(catalogFile) as Record<string, unknown>) : null;
  const index = { schema: 'atl.catalog-index/v2', catalogVersion, contentDigest: 'sha256:dev', generatedAt: deps.ports.clock.now().toISOString(), ...(generated ?? {}), cards: (generated?.cards as unknown[]) ?? cards, tracks };
  await deps.ports.objects.put(web, `${prefix}catalog/index.json`, JSON.stringify(index), { contentType: 'application/json' });
  const nowIso = deps.ports.clock.now().toISOString();
  const repos = reposOf(deps);
  await repos.table.put({ ...Keys.catalogRelease(catalogVersion), type: 'CatalogRelease', ver: 1, createdAt: nowIso, updatedAt: nowIso, catalogVersion, contentDigest: 'sha256:dev', publishedAt: nowIso });
  await repos.table.put({ ...Keys.catalogCurrent(), type: 'CatalogRelease', ver: 1, createdAt: nowIso, updatedAt: nowIso, catalogVersion });
  clearContentCache();
  return { catalogVersion, cards: cards.map((c) => String(c.id)), tracks: tracks.map((t) => String(t.id)) };
}

export async function ensureDevPlatformConfig(deps: FunctionDeps, port: number): Promise<void> {
  const repos = reposOf(deps);
  if (await repos.platform.config(true)) return;
  const { devPlatformConfig } = await loadDevTables();
  await repos.table.put(devPlatformConfig(deps.ports.clock.now().toISOString(), deps.env.region, deps.env.accountId, port), { expression: 'attribute_not_exists(PK)' }).catch(() => undefined);
}

// ---------------------------------------------------------------------------------------------------------------

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--dev-mode')) process.env.ATL_DEV_MODE = '1';
  if (process.env.ATL_DEV_MODE !== '1') {
    console.error('set ATL_DEV_MODE=1 (or pass --dev-mode) to start the ATL dev server');
    process.exit(2);
  }
  const portArg = argv.indexOf('--port');
  if (portArg >= 0 && argv[portArg + 1]) process.env.ATL_DEV_PORT = argv[portArg + 1];
  const cfg = (await loadDevConfigModule()).loadDevConfig();
  const rt = await (await loadDevRuntime()).createDevRuntime(cfg);
  await ensureDevPlatformConfig(rt.deps, cfg.port);
  const seedArg = argv.indexOf('--seed-catalog');
  if (seedArg >= 0) {
    const dir = path.resolve(argv[seedArg + 1] && !argv[seedArg + 1]!.startsWith('--') ? argv[seedArg + 1]! : 'labs');
    const r = await seedDevCatalog(rt.deps, dir);
    console.log(`seeded content release ${r.catalogVersion}: ${r.cards.length} cards, ${r.tracks.length} tracks from ${dir}`);
  }
  const app = createDevApp(rt);
  const server = app.listen(cfg.port, '127.0.0.1', () => {
    console.log(`ATL API dev server on http://127.0.0.1:${cfg.port}  (DynamoDB ${cfg.ddbEndpoint}, time x${cfg.timeScale}, runner ${cfg.runnerMode})`);
  });
  const stop = async () => {
    server.close();
    await rt.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
}

if (process.argv[1] && /dev-server\.(ts|js)$/.test(process.argv[1])) {
  void main();
}
