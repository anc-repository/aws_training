// 测试装配：只用 local-identity 负责的本地驱动 + 路由，其余端口用内存假实现（不依赖其他实现者的进行中代码）。
// 中间件顺序与 http/app.ts 一致：body → cookie → 请求上下文 → 可观测性 → 认证 → 旁路守卫 → 只读窗口 → 路由 → 404 → 错误处理。
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import cookieParser from 'cookie-parser';
import express, { type ErrorRequestHandler, type Express } from 'express';
import { lazyAwsClients } from '../../src/adapters/aws/clients.js';
import { LocalAuth } from '../../src/adapters/auth/local.js';
import { FileConfig } from '../../src/adapters/config/file.js';
import { OutboxEmail } from '../../src/adapters/email/outbox.js';
import { LocalCrypto } from '../../src/adapters/kms/local.js';
import { FileLock } from '../../src/adapters/lock/file.js';
import { FileLogger } from '../../src/adapters/logging/file.js';
import { LocalMetrics } from '../../src/adapters/monitoring/local.js';
import { DbNotifier } from '../../src/adapters/notification/db.js';
import { EnvSecrets } from '../../src/adapters/secrets/env.js';
import { NoTracer } from '../../src/adapters/tracing/none.js';
import type { AdapterDeps } from '../../src/adapters/types.js';
import { validateConfig } from '../../src/config/validate.js';
import type { Container } from '../../src/container.js';
import { createKnex, instrumentKnex, migrateLatest } from '../../src/db/knex.js';
import { HttpError, isNotImplemented } from '../../src/errors.js';
import { auditBypass } from '../../src/http/middleware/audit.js';
import { authenticate } from '../../src/http/middleware/auth.js';
import { observability } from '../../src/http/middleware/observability.js';
import { readOnlyGuard } from '../../src/http/middleware/readonly.js';
import { requestContext } from '../../src/http/middleware/request-context.js';
import * as adminRoutes from '../../src/http/routes/admin.js';
import * as albumRoutes from '../../src/http/routes/albums.js';
import * as authRoutes from '../../src/http/routes/auth.js';
import * as capabilityRoutes from '../../src/http/routes/capabilities.js';
import * as healthRoutes from '../../src/http/routes/health.js';
import * as labRoutes from '../../src/http/routes/lab.js';
import * as notificationRoutes from '../../src/http/routes/notifications.js';
import { CapabilityRegistry } from '../../src/modules/capabilities.js';
import { bypassGuard } from '../../src/observability/bypass.js';
import { FaultRegistry } from '../../src/observability/faults.js';
import { instrument } from '../../src/observability/instrument.js';
import { LabMetricsStore } from '../../src/observability/lab-metrics.js';
import { currentContext, markPath } from '../../src/observability/request-context.js';
import type * as P from '../../src/ports/index.js';
import type { ModuleId } from '../../src/ports/common.js';
import { labMetricsDbSink } from '../../src/repositories/lab.js';
import { tempEnvDir } from './config.js';

export function generateEs256Pem(): string {
  return generateKeyPairSync('ec', { namedCurve: 'P-256', privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey;
}

export function l0Secrets(): Record<string, string> {
  const k = () => randomBytes(32).toString('base64');
  return {
    SECRETS_ORIGIN: 'instance', UPLOAD_HMAC_KEY: k(), MEDIA_HMAC_KEY: k(), CALLBACK_HMAC_KEY: k(), INTERNAL_HMAC_KEY: k(), COOKIE_SECRET: k(),
    LOCAL_MASTER_KEY: k(),
  };
}

/** 写一个完整的 L0 配置目录（cloudalbum.env + secrets.env + keys/jwt-es256.pem + 可选 runtime.json） */
export function l0EnvDir(opts: { base?: Record<string, string>; secrets?: Record<string, string> | null; runtime?: Record<string, unknown>; withKey?: boolean } = {}):
  { envDir: string; dataDir: string } {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'cloudalbum-id-data-')).replace(/\\/g, '/');
  const raw: Record<string, string> = {};
  if (opts.withKey !== false) raw['keys/jwt-es256.pem'] = generateEs256Pem();
  if (opts.runtime) raw['runtime.json'] = JSON.stringify(opts.runtime);
  const envDir = tempEnvDir({
    base: { APP_BASE_URL: 'http://localhost:3000', CLOUDALBUM_DATA_DIR: dataDir, LOCK_FILE_DIR: `${dataDir}/run`, ...(opts.base ?? {}) },
    ...(opts.secrets === null ? {} : { secrets: opts.secrets ?? l0Secrets() }),
    raw,
  });
  return { envDir, dataDir };
}

// ------------------------------------------------------------------------------------------------
// 其他端口的内存假实现（测试只关心它们被正确调用）
// ------------------------------------------------------------------------------------------------

const meta = (module: ModuleId, driver: string): P.AdapterMeta => ({ module, driver, awsService: null, authoritative: false });

export class FakeCache implements P.CachePort {
  readonly meta = meta('cache', 'memory');
  readonly store = new Map<string, { v: unknown; exp: number }>();
  readonly counters = new Map<string, number>();
  async probe(): Promise<P.ProbeResult> { return { status: 'ok', detail: 'fake' }; }
  async get<T>(key: string): Promise<{ value?: T; outcome: P.CacheOutcome }> {
    const e = this.store.get(key);
    return e && e.exp > Date.now() ? { value: e.v as T, outcome: 'hit' } : { outcome: 'miss' };
  }
  async set<T>(key: string, value: T, ttlSec: number): Promise<void> { this.store.set(key, { v: value, exp: Date.now() + ttlSec * 1000 }); }
  async del(keys: string[]): Promise<void> { for (const k of keys) this.store.delete(k); }
  async wrap<T>(key: string, ttlSec: number, loader: () => Promise<T>): Promise<T> {
    if (currentContext()?.bypass.has('cache')) {
      markPath('cache', 'memory:bypass');
      return loader();
    }
    const hit = await this.get<T>(key);
    if (hit.value !== undefined) {
      markPath('cache', 'memory:hit');
      return hit.value;
    }
    markPath('cache', 'memory:miss');
    const v = await loader();
    await this.set(key, v, ttlSec);
    return v;
  }
  async incr(key: string): Promise<number> {
    const n = (this.counters.get(key) ?? 0) + 1;
    this.counters.set(key, n);
    return n;
  }
}

export class FakeQueue implements P.QueuePort {
  readonly meta = meta('queue', 'sync');
  readonly semantics = { durable: false, consumer: 'inline' as const, delivery: 'inline' as const };
  handlers: Partial<Record<P.JobName, P.JobHandler>> = {};
  readonly enqueued: Array<{ name: P.JobName; payload: unknown }> = [];
  async probe(): Promise<P.ProbeResult> { return { status: 'ok', detail: 'fake' }; }
  bind(handlers: Partial<Record<P.JobName, P.JobHandler>>): void { this.handlers = { ...this.handlers, ...handlers }; }
  async enqueue<T>(name: P.JobName, payload: T): Promise<{ jobId: string; mode: 'inline' | 'queued' }> {
    this.enqueued.push({ name, payload });
    const h = this.handlers[name];
    if (!h) throw new Error(`no handler bound for ${name}`);
    await h({ id: `job-${this.enqueued.length}`, name, payload, attempt: 1, enqueuedAt: new Date().toISOString() });
    return { jobId: `job-${this.enqueued.length}`, mode: 'inline' };
  }
  async consume(): Promise<void> {}
  async stats(): Promise<{ depth: number; inFlight: number }> { return { depth: 0, inFlight: 0 }; }
  async drain(): Promise<{ remaining: number }> { return { remaining: 0 }; }
}

export class FakeScheduler implements P.SchedulerPort {
  readonly meta = meta('scheduler', 'cron');
  readonly runs: P.JobRun[] = [];
  async probe(): Promise<P.ProbeResult> { return { status: 'ok', detail: 'fake' }; }
  register(): void {}
  async start(): Promise<void> {}
  async triggerNow(name: P.ScheduledJobName): Promise<P.JobRun> {
    const now = new Date().toISOString();
    const run: P.JobRun = { runId: `run-${this.runs.length + 1}`, name, scheduledAt: now, startedAt: now, finishedAt: now, status: 'ok', host: 'test', trigger: 'manual' };
    this.runs.unshift(run);
    return run;
  }
  async listRuns(limit: number): Promise<P.JobRun[]> { return this.runs.slice(0, limit); }
}

function fakeStorage(): P.StoragePort {
  return {
    meta: { module: 'storage', driver: 'local', awsService: null, authoritative: true },
    async probe() { return { status: 'ok', detail: 'fake' }; },
    async createReadUrl(key: string, o: { visibility: P.Visibility }) { return `/media/${key}?v=${o.visibility}&sig=test`; },
    internalRedirectPath: () => null,
  } as unknown as P.StoragePort;
}

// ------------------------------------------------------------------------------------------------
// 装配
// ------------------------------------------------------------------------------------------------

export interface Harness {
  c: Container;
  app: Express;
  envDir: string;
  dataDir: string;
  queue: FakeQueue;
  scheduler: FakeScheduler;
  cache: FakeCache;
  adapters: { auth: LocalAuth; email: OutboxEmail; runtime: FileConfig; secrets: EnvSecrets; crypto: LocalCrypto; logger: FileLogger };
  close(): Promise<void>;
}

export async function makeHarness(opts: Parameters<typeof l0EnvDir>[0] = {}): Promise<Harness> {
  const { envDir, dataDir } = l0EnvDir(opts);
  const v = await validateConfig({ role: 'api', envDir, processEnv: { NODE_ENV: 'test' } });
  if (!v.ok || !v.parsed.config) throw new Error(`config invalid: ${JSON.stringify(v.parsed.errors)} ${JSON.stringify(v.verdict.errors)}`);
  const cfg = v.parsed.config;
  const env = v.parsed.effective;
  const caps = new CapabilityRegistry({ cfg, env, verdict: v.verdict, role: 'api' });
  const labMetrics = new LabMetricsStore({ role: 'api', dataDir });
  const faults = new FaultRegistry();
  const observers = [caps, labMetrics];
  const db = instrumentKnex(await createKnex(cfg, undefined, { sqliteFilename: path.join(dataDir, 'db', 'test.sqlite') }), 'sqlite', observers);
  await migrateLatest(db);
  labMetrics.setSink(labMetricsDbSink(db));

  const deps: AdapterDeps = { cfg, env: v.layers.merged, aws: lazyAwsClients({ region: cfg.core.AWS_REGION, credentials: null }), role: 'api', labMetrics, db, dbRead: db };
  const wrap = <T extends P.Adapter>(a: T, register = true): T => {
    if (register) caps.registerAdapter(a.meta.module, a);
    return instrument(a, { observers, faults });
  };
  const init = async (a: P.Adapter) => {
    try {
      await a.init?.();
    } catch (e) {
      caps.reportFailure(a.meta.module, e);
    }
  };

  const secretsRaw = new EnvSecrets(deps);
  const secrets = wrap(secretsRaw);
  deps.secrets = secrets;
  const loggerRaw = new FileLogger(deps);
  await init(loggerRaw);
  caps.registerAdapter('logging', loggerRaw);
  deps.logger = loggerRaw;
  const runtimeRaw = new FileConfig(deps);
  await init(runtimeRaw);
  caps.registerAdapter('config', runtimeRaw);
  deps.runtime = runtimeRaw;
  const cryptoRaw = new LocalCrypto(deps);
  await init(cryptoRaw);
  deps.crypto = wrap(cryptoRaw);
  const emailRaw = new OutboxEmail(deps);
  deps.email = wrap(emailRaw);
  const notifier = wrap(new DbNotifier(deps));
  deps.notifier = notifier;
  const metrics = new LocalMetrics(deps);
  caps.registerAdapter('monitoring', metrics);
  const tracer = new NoTracer(deps);
  caps.registerAdapter('tracing', tracer);
  const cache = new FakeCache();
  const queue = new FakeQueue();
  const scheduler = new FakeScheduler();
  const lock = new FileLock(deps);
  const authRaw = new LocalAuth(deps);
  await init(authRaw);
  const auth = wrap(authRaw);

  const runtimeConfig = (): P.RuntimeConfig => runtimeRaw.current();
  caps.setRuntimeConfigProvider(runtimeConfig);
  const c = {
    role: 'api', config: cfg, env, layers: v.layers, verdict: v.verdict, db, dbRead: db, lock, capabilities: caps, labMetrics, faults,
    aws: deps.aws, auth, cache: wrap(cache, false), queue: wrap(queue, false), scheduler: wrap(scheduler, false), storage: fakeStorage(),
    cdn: { meta: meta('cdn', 'direct'), baseUrl: null, probe: async () => ({ status: 'ok', detail: 'fake' }), invalidate: async () => ({ id: null, status: 'skipped' }) },
    notifier, email: deps.email, secrets, runtime: runtimeRaw, runtimeConfig, crypto: deps.crypto, logger: loggerRaw, loggerPort: loggerRaw, metrics, tracer,
    detectors: [], startBackground() {}, async close() {},
  } as unknown as Container;

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');
  app.set('etag', false);
  app.use(express.json({ limit: '1mb', verify: (req, _res, buf) => { (req as express.Request & { rawBody?: Buffer }).rawBody = Buffer.from(buf); } }));
  app.use(cookieParser());
  app.use(requestContext());
  app.use(observability(c));
  app.use(authenticate(c));
  app.use(bypassGuard({ runtime: () => c.runtimeConfig(), cache: () => c.cache, audit: auditBypass(c) }));
  app.use(readOnlyGuard(c));
  healthRoutes.register(app, c);
  capabilityRoutes.register(app, c);
  authRoutes.register(app, c);
  authRoutes.registerSelfOutbox(app, c);
  albumRoutes.register(app, c);
  notificationRoutes.register(app, c);
  adminRoutes.register(app, c);
  labRoutes.register(app, c);
  app.use((req, res) => { res.status(404).json({ error: 'NOT_FOUND', path: req.path }); });
  const onError: ErrorRequestHandler = (err: unknown, _req, res, _next) => {
    if (res.headersSent) return;
    if (isNotImplemented(err)) {
      res.status(501).json({ error: 'NOT_IMPLEMENTED', message: (err as Error).message });
      return;
    }
    if (err instanceof HttpError) {
      if (err.headers) res.set(err.headers);
      res.status(err.status).json({ error: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) });
      return;
    }
    const status = (err as { status?: number })?.status;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      res.status(status).json({ error: 'BAD_REQUEST', message: (err as Error).message });
      return;
    }
    res.status(500).json({ error: 'INTERNAL', message: (err as Error)?.message });
  };
  app.use(onError);

  return {
    c, app, envDir, dataDir, queue, scheduler, cache,
    adapters: { auth: authRaw, email: emailRaw, runtime: runtimeRaw, secrets: secretsRaw, crypto: cryptoRaw, logger: loggerRaw },
    async close() {
      await runtimeRaw.close();
      await loggerRaw.flush();
      await db.destroy();
    },
  };
}

export function ensureDir(p: string): string {
  mkdirSync(p, { recursive: true });
  return p;
}

export function writeRuntime(envDir: string, runtime: Record<string, unknown>): void {
  writeFileSync(path.join(envDir, 'runtime.json'), JSON.stringify(runtime));
}
