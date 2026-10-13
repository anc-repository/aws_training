/**
 * `npm run smoke:platform` — ATL platform end-to-end self-test in ATL_DEV_MODE=1 (docs/implementation-notes.md
 * “platform-integration”). Everything runs on this machine: DynamoDB Local (docker-compose.platform.yml), the in-process
 * Step Functions simulator with the real statemachines/*.asl.json, the twelve functions in-process, the dev runner in
 * `local-l0` mode (base-deploy starts a local CloudAlbum L0 in platform mode, destroy stops it), the dev check runner
 * (platform/checks against that L0), the scaled dev clock (skip = fast-forward), the local ECDSA signer and fake
 * CloudTrail. No AWS API is called; every `AWS_*` variable is removed from child processes.
 *
 *   npm run smoke:platform [-- --keep] [--time-scale 5] [--skip-package]
 *
 * Phases (each prints PASS / FAIL lines; the run fails if any line fails; result JSON: .atl-dev/smoke/last-platform.json):
 *   0 builds: check bundle, content release (labs:build when missing), release package + SHA256SUMS (no upload)
 *   1 platform init: per-run tables, install custom resources (SeedData, WebDeploy of atl-content.zip, JwksPublish,
 *     UninstallGuard Create) → catalog API: 56 cards, 10 startable, the rest planned
 *   2 svc-storage: quote → start → PROVISIONING (base-deploy = local L0, workstation-up, profile-apply) → READY → RUNNING
 *   3 step 1 checks (local + capability) pass; 4 a manual confirmation; 5 a comparison experiment (two labels)
 *   6 extend once → fast-forward → EXPIRING → ENDING → CLEANING → ENDED (the reclaimer removes the local resources)
 *   7 report → completion records (dev fixture for the quick-compare cards) → badge → quick-compare certificate →
 *     offline verify tool + static verify page logic → revoke → verification fails
 *   8 failure path: fault in the reclaim → CLEANUP_FAILED → manual list → “我已处理” → re-check → ENDED
 *   9 uninstall guard: refused while a session is not terminal
 */
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes, webcrypto } from 'node:crypto';
import fs from 'node:fs';
import type http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { DeleteTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { canonicalJson, Keys, ScheduleNames, WebKeys, type LambdaFunctionName } from '@atl/shared';
import { createDevApp } from '../dev-server.js';
import { installDevCustomResources, type DevCustomResources } from './adapters/custom-resources.js';
import { ScaledClock } from './adapters/clock.js';
import { devToken } from './adapters/auth.js';
import { loadDevConfig, REPO_ROOT } from './config.js';
import { assertLocalEndpoint, createTables } from './create-tables.js';
import { createDevRuntime, type DevRuntime } from './runtime.js';
import { createDevExtensions, type DevExtensions } from './adapters/workspace.js';

// ---------------------------------------------------------------------------------------------------------------
// options and reporting

const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(n);
const opt = (n: string, d: string) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] && !argv[i + 1]!.startsWith('--') ? argv[i + 1]! : d;
};

const TIME_SCALE = Number(opt('--time-scale', '5'));
const KEEP = flag('--keep');
const SKIP_PACKAGE = flag('--skip-package');
const SUB = 'smoke-learner';
const LEARNER = devToken('learner', SUB);
const ASSISTANT = devToken('assistant', 'smoke-assistant');
const LAB = 'svc-storage';
const TRACK = 'quick-compare';
const STAMP = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').toLowerCase();
const DATA_DIR = path.join(REPO_ROOT, '.atl-dev', 'smoke', `platform-${STAMP}`);
const REAL_T0 = Date.now();

interface Line {
  phase: string;
  name: string;
  ok: boolean;
  detail?: string;
  atMs: number;
}

const lines: Line[] = [];
let phase = '0';

function check(name: string, ok: boolean, detail?: unknown): boolean {
  const d = detail === undefined ? undefined : typeof detail === 'string' ? detail : JSON.stringify(detail);
  lines.push({ phase, name, ok, ...(d ? { detail: d.slice(0, 2000) } : {}), atMs: Date.now() - REAL_T0 });
  const t = ((Date.now() - REAL_T0) / 1000).toFixed(1).padStart(6);
  console.log(`${t}s  ${ok ? 'PASS' : 'FAIL'}  [${phase}] ${name}${d && !ok ? `\n          ${d.slice(0, 1500)}` : d ? `  — ${d.slice(0, 200)}` : ''}`);
  return ok;
}

class PhaseFailed extends Error {
  recorded = false;
}

function must(name: string, ok: boolean, detail?: unknown): void {
  if (!check(name, ok, detail)) {
    const e = new PhaseFailed(name);
    e.recorded = true;
    throw e;
  }
}

function log(s: string): void {
  console.log(`${((Date.now() - REAL_T0) / 1000).toFixed(1).padStart(6)}s        ${s}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(what: string, fn: () => Promise<T | null | undefined | false>, timeoutMs = 120_000, everyMs = 250): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new PhaseFailed(`timed out after ${timeoutMs / 1000}s: ${what}`);
    await sleep(everyMs);
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      s.close(() => resolve(typeof a === 'object' && a ? a.port : 0));
    });
  });
}

/** Child processes never see AWS credentials (the smoke never calls AWS). */
function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^AWS_/i.test(k)) env[k] = v;
  return { ...env, ...extra };
}

function run(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(cmd, args, { cwd: opts.cwd ?? REPO_ROOT, env: opts.env ?? childEnv(), encoding: 'utf8', timeout: opts.timeoutMs ?? 600_000, shell: false, windowsHide: true });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? (r.error ? String(r.error) : '') };
}

const TSX_CLI = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const tsx = (script: string, args: string[], timeoutMs = 600_000) => run(process.execPath, [TSX_CLI, script, ...args], { timeoutMs });

// ---------------------------------------------------------------------------------------------------------------
// HTTP client of the dev API

let BASE = '';

interface Res {
  status: number;
  body: Record<string, unknown>;
  headers: Headers;
}

async function call(method: string, p: string, o: { token?: string; caller?: string; body?: unknown; key?: string; headers?: Record<string, string> } = {}): Promise<Res> {
  const headers: Record<string, string> = { ...(o.headers ?? {}) };
  if (o.token) headers.authorization = `Bearer ${o.token}`;
  if (o.caller) headers['x-atl-dev-caller'] = o.caller;
  if (o.body !== undefined) headers['content-type'] = 'application/json';
  if (method === 'POST' || (method === 'PUT' && p.endsWith('/result'))) headers['idempotency-key'] = o.key ?? randomBytes(12).toString('hex');
  const r = await fetch(`${BASE}${p}`, { method, headers, ...(o.body === undefined ? {} : { body: JSON.stringify(o.body) }) });
  const text = await r.text();
  let body: Record<string, unknown> = {};
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    body = { raw: text };
  }
  return { status: r.status, body, headers: r.headers };
}

const wsCaller = (sid: string) => `arn:aws:sts::000000000000:assumed-role/ATLLearnerRole/atl-${sid}-ws`;

async function session(sid: string): Promise<Record<string, unknown>> {
  return (await call('GET', `/api/v1/sessions/${sid}`, { token: LEARNER })).body;
}

async function events(sid: string): Promise<{ type: string; data: Record<string, unknown> }[]> {
  const out: { type: string; data: Record<string, unknown> }[] = [];
  let after: string | null = null;
  for (let i = 0; i < 50; i++) {
    const r = await call('GET', `/api/v1/sessions/${sid}/events${after ? `?after=${after}` : ''}`, { token: LEARNER });
    const page = r.body as { events?: { type: string; data: Record<string, unknown> }[]; next?: string | null; hasMore?: boolean };
    out.push(...(page.events ?? []));
    if (!page.hasMore || !page.next) break;
    after = page.next;
  }
  return out;
}

/** States the session went through (session.state_changed events) — the events API holds back the last 2 s. */
async function stateTrail(rt: DevRuntime, sid: string): Promise<string[]> {
  const { QueryCommand } = await import('@aws-sdk/lib-dynamodb');
  const r = await rt.deps.db.send(
    new QueryCommand({
      TableName: rt.env.tableName,
      KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :sk)',
      ExpressionAttributeNames: { '#pk': 'PK', '#sk': 'SK' },
      ExpressionAttributeValues: { ':pk': Keys.labSession(sid).PK, ':sk': 'EVT#' },
    }),
  );
  const items = (r.Items ?? []) as { type?: string; data?: { from?: string; to?: string } }[];
  const changes = items.filter((e) => e.type === 'session.state_changed').map((e) => e.data ?? {});
  return changes.length ? [String(changes[0]!.from), ...changes.map((c) => String(c.to))] : [];
}

async function waitState(sid: string, states: string[], timeoutMs = 180_000): Promise<Record<string, unknown>> {
  return until(`session ${sid} in ${states.join('|')}`, async () => {
    const s = await session(sid);
    return states.includes(String(s.state)) ? s : null;
  }, timeoutMs, 500);
}

// ---------------------------------------------------------------------------------------------------------------
// phase 0: builds

interface Builds {
  checksBundleDigest: string;
  checkRunner: string;
  releaseDir: string | null;
}

function phaseBuilds(): Builds {
  phase = '0';
  for (const f of ['backend/dist/server.js', 'backend/dist/cli.js', 'scripts/module-cli/dist/index.js']) {
    must(`build output ${f}`, fs.existsSync(path.join(REPO_ROOT, f)), 'run npm run build first');
  }
  const cb = run(process.execPath, [path.join(REPO_ROOT, 'platform', 'checks', 'build.mjs')]);
  must('check bundle: node platform/checks/build.mjs', cb.status === 0, cb.stderr || cb.stdout);
  const bundle = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'platform', 'checks', 'dist', 'bundle.json'), 'utf8')) as { bundleDigest: string; checks: string[] };
  check('check bundle digest', /^[a-f0-9]{64}$/.test(bundle.bundleDigest), `${bundle.bundleDigest} (${bundle.checks.length} checks)`);
  const contentRoot = path.join(REPO_ROOT, 'dist', 'content');
  const hasContent = fs.existsSync(contentRoot) && fs.readdirSync(contentRoot).some((d) => fs.existsSync(path.join(contentRoot, d, 'manifest.json')));
  if (!hasContent || flag('--rebuild-content')) {
    log('labs:build (dist/content/<catalogVersion>/) …');
    const b = tsx(path.join(REPO_ROOT, 'scripts', 'labs', 'src', 'cli.ts'), ['build']);
    must('content release: labs:build', b.status === 0, (b.stderr || b.stdout).slice(-2000));
  } else check('content release present (dist/content)', true);
  let releaseDir: string | null = null;
  if (!SKIP_PACKAGE) {
    releaseDir = path.join(DATA_DIR, 'release');
    log('package the release (platform/infra/build/package.ts, no upload) …');
    const p = tsx(path.join(REPO_ROOT, 'platform', 'infra', 'build', 'package.ts'), ['--out', releaseDir]);
    must('release package: build/package.ts', p.status === 0, (p.stderr || p.stdout).slice(-2000));
    const sums = fs.readFileSync(path.join(releaseDir, 'SHA256SUMS'), 'utf8');
    let verified = 0;
    for (const line of sums.split('\n')) {
      const m = /^([a-f0-9]{64}) {2}(\S+)$/.exec(line.trim());
      if (!m) continue;
      const actual = createHash('sha256').update(fs.readFileSync(path.join(releaseDir, m[2]!))).digest('hex');
      if (actual !== m[1]) must(`SHA256SUMS: ${m[2]}`, false, `${actual} ≠ ${m[1]}`);
      verified++;
    }
    check('SHA256SUMS verifies every asset', verified >= 6, `${verified} files`);
    check('SHA256SUMS names the check bundle digest', sums.includes(`# checks-bundle-digest ${bundle.bundleDigest}`));
  }
  return { checksBundleDigest: bundle.bundleDigest, checkRunner: path.join(REPO_ROOT, 'platform', 'checks', 'dist', 'atl', 'bin', 'atl-check.mjs'), releaseDir };
}

// ---------------------------------------------------------------------------------------------------------------
// DynamoDB Local

async function ensureDynamoDbLocal(endpoint: string): Promise<void> {
  assertLocalEndpoint(endpoint);
  const ping = async () => {
    try {
      const r = await fetch(endpoint, { signal: AbortSignal.timeout(2000) });
      return r.status > 0;
    } catch {
      return false;
    }
  };
  if (await ping()) return check('DynamoDB Local reachable', true, endpoint) as unknown as void;
  log('DynamoDB Local is not running: docker compose -f docker-compose.platform.yml up -d --wait');
  const r = run('docker', ['compose', '-f', 'docker-compose.platform.yml', 'up', '-d', '--wait'], { timeoutMs: 300_000 });
  must('docker compose up DynamoDB Local', r.status === 0, r.stderr || r.stdout);
  await until('DynamoDB Local', async () => ((await ping()) ? true : null), 60_000, 1000);
}

// ---------------------------------------------------------------------------------------------------------------
// main

interface Ctx {
  rt: DevRuntime;
  cr: DevCustomResources;
  ddb: DynamoDBClient;
  tables: { main: string; locks: string };
  server: http.Server;
  builds: Builds;
  dev: DevExtensions;
}

const clockOf = (rt: DevRuntime) => rt.clock as ScaledClock;
const healthReports: unknown[] = [];

async function main(): Promise<number> {
  process.env.ATL_DEV_MODE = '1';
  fs.mkdirSync(DATA_DIR, { recursive: true });
  console.log(`ATL smoke:platform — data ${path.relative(REPO_ROOT, DATA_DIR)}, time x${TIME_SCALE}`);
  let ctx: Ctx | null = null;
  const results: Record<string, unknown> = {};
  try {
    const builds = phaseBuilds();
    const port = await freePort();
    const cfg = loadDevConfig({
      ...process.env,
      ATL_DEV_DATA_DIR: DATA_DIR,
      ATL_DEV_RUNNER_MODE: 'local-l0',
      ATL_DEV_TIME_SCALE: String(TIME_SCALE),
      ATL_DEV_RUNNER_NOOP_SECONDS: '30',
      ATL_DEV_CHECK_RUNNER: builds.checkRunner,
      ATL_DEV_PORT: String(port),
      ATL_CHECK_BUNDLE_DIGEST: builds.checksBundleDigest,
    });
    process.env.ATL_CHECK_BUNDLE_DIGEST = builds.checksBundleDigest;
    phase = '1';
    await ensureDynamoDbLocal(cfg.ddbEndpoint);
    const suffix = STAMP.slice(-6);
    const tables = { main: `atl-main-smoke-${suffix}`, locks: `cloudalbum-lab-locks-smoke-${suffix}` };
    const ddb = new DynamoDBClient({ region: cfg.region, endpoint: cfg.ddbEndpoint, credentials: { accessKeyId: 'dev', secretAccessKey: 'dev' } });
    await createTables(ddb, { names: { 'atl-main': tables.main, 'cloudalbum-lab-locks': tables.locks } });
    check('per-run tables in DynamoDB Local', true, `${tables.main}, ${tables.locks}`);
    const rt = await createDevRuntime(cfg, { tables });
    // keep the health-gate reports of atl-checks for the diagnostics of a failed start
    const checksFn = rt.checks;
    rt.invoker.register('atl-checks', async (p) => {
      const r = await checksFn(p);
      if ((p as { action?: string } | null)?.action === 'RunHealthGate') healthReports.push(r);
      return r;
    });
    const lifecycleIam = () => rt.lifecycleDev?.lifecycle ?? null;
    const cr = await installDevCustomResources(rt, { db: rt.deps.db, objects: rt.objects, signer: rt.signer, orchestrator: rt.orchestrator, clock: rt.clock, iam: lifecycleIam, tableName: rt.env.tableName });
    // 03 workspace in dev mode: the @atl/ssm-client mock (own instance, free port) and the federation stub
    const dev = await createDevExtensions({ port, dataDir: cfg.dataDir, nowMs: () => rt.clock.nowMs(), envs: rt.envs, ssmMockUrl: 'http://127.0.0.1:0', quiet: true });
    const app = createDevApp(rt, { ext: dev.ext, federation: dev.federation });
    const server = await new Promise<http.Server>((resolve) => {
      const s = app.listen(port, '127.0.0.1', () => resolve(s));
    });
    BASE = `http://127.0.0.1:${port}`;
    ctx = { rt, cr, ddb, tables, server, builds, dev };
    await rt.scheduler.setSweeperEnabled(true);

    await phaseInit(ctx);
    const sid = await phaseStart(ctx);
    results.sessionId = sid;
    await phaseWorkspace(ctx, sid);
    await phaseChecks(ctx, sid);
    await phaseManual(ctx, sid);
    await phaseExperiment(ctx, sid);
    await phaseExpire(ctx, sid);
    await phaseReportAndCertificate(ctx, sid);
    const sid2 = await phaseCleanupFailure(ctx);
    results.failureSessionId = sid2;
    await phaseUninstallGuard(ctx);
  } catch (e) {
    if (e instanceof PhaseFailed) {
      if (!e.recorded) check(e.message, false);
    } else check('unexpected error', false, e instanceof Error ? `${e.name}: ${e.message}\n${e.stack ?? ''}` : String(e));
  } finally {
    if (ctx) {
      const asyncErrors = ctx.rt.invoker.asyncErrors.filter((x) => !/Atl\.(NotImplemented|SessionNotRunning)/.test(x.error));
      if (asyncErrors.length) log(`async invocation errors (informational): ${JSON.stringify(asyncErrors.slice(-10))}`);
      results.asyncErrors = asyncErrors.slice(-30);
      const l0Roots = ctx.rt.envs.list().map((e) => e.root).filter((r): r is string => !!r);
      ctx.server.closeAllConnections();
      await new Promise((r) => ctx!.server.close(r));
      await ctx.dev.close();
      await ctx.rt.close();
      if (!KEEP) {
        for (const t of [ctx.tables.main, ctx.tables.locks]) {
          await ctx.ddb.send(new DeleteTableCommand({ TableName: t })).catch((e: unknown) => log(`could not delete table ${t}: ${String(e)}`));
        }
        // the local L0 instances' config / data directories (.cloudalbum/smoke/atl-<envName>-*)
        if (lines.every((l) => l.ok)) for (const r of l0Roots) fs.rmSync(r, { recursive: true, force: true });
      }
    }
  }
  const failed = lines.filter((l) => !l.ok);
  const summary = { schema: 'atl.smoke-platform/v1', startedAt: new Date(REAL_T0).toISOString(), seconds: Math.round((Date.now() - REAL_T0) / 1000), timeScale: TIME_SCALE, passed: lines.length - failed.length, failed: failed.length, dataDir: DATA_DIR, ...results, lines };
  fs.mkdirSync(path.join(REPO_ROOT, '.atl-dev', 'smoke'), { recursive: true });
  fs.writeFileSync(path.join(REPO_ROOT, '.atl-dev', 'smoke', 'last-platform.json'), JSON.stringify(summary, null, 2));
  if (!KEEP && failed.length === 0) fs.rmSync(DATA_DIR, { recursive: true, force: true });
  console.log(`\nsmoke:platform: ${lines.length - failed.length} / ${lines.length} passed in ${summary.seconds}s${failed.length ? ` — FAILED: ${failed.map((f) => `[${f.phase}] ${f.name}`).join('; ')}` : ''}`);
  return failed.length ? 1 : 0;
}

// ---------------------------------------------------------------------------------------------------------------
// phase 1: platform initialization (install custom resources) and the catalog

function cfnEvent(type: string, requestType: 'Create' | 'Delete', props: Record<string, unknown>): Record<string, unknown> {
  return {
    RequestType: requestType,
    ResponseURL: `https://cloudformation-custom-resource-response.dev.invalid/${type}/${randomBytes(4).toString('hex')}`,
    StackId: 'arn:aws:cloudformation:ap-northeast-1:000000000000:stack/atl/00000000-0000-4000-8000-000000000000',
    RequestId: randomBytes(8).toString('hex'),
    ResourceType: `Custom::${type}`,
    LogicalResourceId: type,
    PhysicalResourceId: `atl-${type.toLowerCase()}`,
    ResourceProperties: { ServiceToken: 'arn:aws:lambda:ap-northeast-1:000000000000:function:atl-custom-resources', ...props },
  };
}

async function customResource(c: Ctx, type: string, requestType: 'Create' | 'Delete', props: Record<string, unknown>): Promise<{ status: string; data: Record<string, unknown> }> {
  const r = (await c.rt.invoker.invoke('atl-custom-resources' as LambdaFunctionName, cfnEvent(type, requestType, props))) as { status: string; data?: Record<string, unknown>; reason?: string };
  return { status: r.status, data: r.data ?? { reason: r.reason } };
}

async function phaseInit(c: Ctx): Promise<void> {
  phase = '1';
  const { rt } = c;
  const env = rt.env;
  const releasePrefix = 'releases/dev/';
  // the install custom resources, in template order (90-install.yaml): SeedData → WebDeploy → JwksPublish → UninstallGuard
  const seed = await customResource(c, 'SeedData', 'Create', {
    Table: env.tableName,
    Version: '0.1.0-dev',
    ReleaseVersion: 'dev',
    InstallationId: '00000000-0000-4000-8000-000000000000',
    Region: env.region,
    DrRegion: 'ap-northeast-3',
    PlatformUrl: `https://127.0.0.1:${new URL(BASE).port}`,
    AgentApiEndpoint: BASE,
    WorkloadBoundaryArn: `arn:aws:iam::${env.accountId}:policy/ATLWorkloadBoundary`,
    MaxSessionMinutes: '240',
    ExtensionMinutes: '30',
    MaxExtensions: '2',
    MaxKeepHours: '24',
    EnvMaxAgeDays: '7',
    ReadyIdleMinutes: '60',
    AsgMaxSizeLimit: '2',
    AllowedInstanceTypes: 't4g.small,t4g.medium',
    WorkstationInstanceType: 't4g.small',
    MonthlyBudgetAmount: '0',
    BudgetEnforcement: 'block-start',
    TerminalRecording: 'off',
    ExternalAccessAnalyzer: 'none',
    UserPoolId: 'ap-northeast-1_dev',
    AssistantEmails: '',
  });
  check('Custom::SeedData → PLATFORM/CONFIG', seed.status === 'SUCCESS', seed);
  if (c.builds.releaseDir) {
    for (const f of ['atl-web.zip', 'atl-content.zip', 'release-manifest.json']) {
      await rt.objects.put(env.buckets.artifacts, `${releasePrefix}${f}`, fs.readFileSync(path.join(c.builds.releaseDir, f)));
    }
    const web = await customResource(c, 'WebDeploy', 'Create', {
      ArtifactsBucket: env.buckets.artifacts,
      ReleasePrefix: releasePrefix,
      WebBucket: env.buckets.web,
      Table: env.tableName,
      Version: '0.1.0-dev',
      Config: { apiBase: '/api/v1', region: env.region, platformUrl: BASE, version: '0.1.0-dev', releaseVersion: 'dev' },
    });
    check('Custom::WebDeploy publishes atl-content.zip (content/<catalogVersion>/, private quiz, CatalogRelease)', web.status === 'SUCCESS' && web.data.Content !== 'skipped', web);
  } else {
    const { publishDevContent, findContentBuild } = await import('../dev-server.js');
    const dir = findContentBuild(REPO_ROOT);
    must('content build for --skip-package', !!dir);
    const r = await publishDevContent(rt.deps, dir!);
    check('dev content release published (publishDevContent)', r.cards === 56, r);
  }
  const jwks = await customResource(c, 'JwksPublish', 'Create', { KeyId: env.signingKeyId, WebBucket: env.buckets.web, Table: env.tableName });
  check('Custom::JwksPublish → SigningKey + /.well-known/atl/jwks.json', jwks.status === 'SUCCESS' && !!(await rt.objects.get(env.buckets.web, WebKeys.jwks)), jwks);
  const guard = await customResource(c, 'UninstallGuard', 'Create', { Table: env.tableName, KeepPolicies: { ATLLearnerRole: { Inline: ['ATLLearnerIam'], Managed: [] } } });
  check('Custom::UninstallGuard Create records the keep-lists', guard.status === 'SUCCESS', guard);
  check('every install custom resource answered CloudFormation SUCCESS', c.cr.responses.length === 4 && c.cr.responses.every((r) => r.status === 'SUCCESS'), c.cr.responses.map((r) => `${r.status} ${r.reason}`));
  // the dev server's agent endpoint: PlatformConfig.agentApiEndpoint (SeedData) must be the dev server
  const plat = await call('GET', '/api/v1/platform', { token: LEARNER });
  check('GET /platform', plat.status === 200, { status: plat.status, version: plat.body.version, region: plat.body.region });
  const me = await call('GET', '/api/v1/me', { token: LEARNER });
  check('GET /me creates the learner profile', me.status === 200, { sub: me.body.sub, groups: me.body.groups });
  const cat = await call('GET', '/api/v1/catalog', { token: LEARNER });
  check('GET /catalog: current content release', cat.status === 200 && typeof cat.body.catalogVersion === 'string', { catalogVersion: cat.body.catalogVersion });
  // the card catalog is static content behind CloudFront (08 §5: P02 reads catalog/index.json; GET /labs adds my status)
  const indexUrl = String(cat.body.indexUrl ?? '');
  const idx = (await fetch(`${BASE}${indexUrl}`).then((r) => (r.ok ? r.json() : {})).catch(() => ({}))) as { cards?: { id: string; status?: string; startable?: boolean }[] };
  const cards = idx.cards ?? [];
  const planned = cards.filter((x) => x.status === 'planned');
  const startable = cards.filter((x) => x.startable === true && x.status !== 'planned');
  must(`catalog index ${indexUrl} lists 56 cards`, cards.length === 56, { indexUrl, count: cards.length });
  check('10 cards can start, 46 are planned', startable.length === 10 && planned.length === 46, { startable: startable.map((x) => x.id) });
  const labs = await call('GET', '/api/v1/labs', { token: LEARNER });
  check('GET /labs: my status per card (none yet), environment strip', labs.status === 200 && Array.isArray(labs.body.items), { items: (labs.body.items as unknown[] | undefined)?.length, environment: labs.body.environment ?? null });
  const lab = await call('GET', `/api/v1/labs/${LAB}`, { token: LEARNER });
  check(`GET /labs/${LAB}: canStart`, lab.status === 200 && (lab.body.startability as { canStart?: boolean })?.canStart === true, lab.body.startability);
  const p = planned[0]?.id ?? 'svc-vpc';
  const pl = await call('GET', `/api/v1/labs/${p}`, { token: LEARNER });
  const reasons = ((pl.body.startability as { reasons?: { code: string }[] } | undefined)?.reasons ?? []).map((r) => r.code);
  check(`planned card ${p}: not startable (LAB_PLANNED)`, (pl.body.startability as { canStart?: boolean })?.canStart === false && reasons.includes('LAB_PLANNED'), reasons);
  const pq = await call('POST', `/api/v1/labs/${p}/quotes`, { token: LEARNER, body: { purpose: 'START' } });
  check(`planned card ${p}: quote refused`, pq.status === 400 && pq.body.reason === 'LAB_PLANNED', { status: pq.status, code: pq.body.code, reason: pq.body.reason });
  const tracks = await call('GET', '/api/v1/tracks', { token: LEARNER });
  check('GET /tracks: 9 learning paths incl. quick-compare', ((tracks.body.items as { id?: string; trackId?: string }[]) ?? []).length === 9, ((tracks.body.items as { id?: string }[]) ?? []).map((t) => t.id));
}

// ---------------------------------------------------------------------------------------------------------------
// phase 2: quote → start → READY → RUNNING

async function phaseStart(c: Ctx): Promise<string> {
  phase = '2';
  const { rt } = c;
  const q = await call('POST', `/api/v1/labs/${LAB}/quotes`, { token: LEARNER, body: { purpose: 'START' } });
  must('quote START', q.status === 201 && typeof q.body.quoteId === 'string', q.body);
  const lines2 = (q.body.lines as { unknown?: boolean; perHourLow?: number; group?: string }[] | undefined) ?? [];
  const hourly2 = q.body.hourly as { start?: { low?: number }; completed?: { typical?: number } } | null;
  check(
    'quote: atl-pricing expands cost.basis and prices it from the dev Price List fixture (pricing=fixture, labelled “not an AWS price”)',
    q.body.pricing === 'fixture' && lines2.some((l) => typeof l.perHourLow === 'number') && typeof hourly2?.start?.low === 'number' && ((q.body.notes as string[] | undefined) ?? []).some((n) => n.includes('不是 AWS 价格')),
    { pricing: q.body.pricing, lines: lines2.length, hourly: q.body.hourly ?? null, incomplete: q.body.incomplete ?? null, platformOverhead: q.body.platformOverhead ?? null },
  );
  const s = await call('POST', '/api/v1/sessions', { token: LEARNER, body: { labId: LAB, quoteId: q.body.quoteId, costAcknowledged: true } });
  must('POST /sessions → 202', s.status === 202 && typeof s.body.sessionId === 'string', s.body);
  const sid = String(s.body.sessionId);
  log(`session ${sid}: waiting for PROVISIONING → READY (base-deploy starts a local CloudAlbum L0) …`);
  await waitState(sid, ['PROVISIONING', 'READY', 'FAILED', 'ENDING', 'ENDED'], 120_000);
  // the agent context is readable while PROVISIONING (C4(b)) — ATL-WorkstationSetup reads it
  const ctxR = await call('GET', `/api/v1/agent/sessions/${sid}/context`, { caller: wsCaller(sid) });
  check('agent context (PROVISIONING / READY, caller atl-<sid>-ws)', ctxR.status === 200 && ctxR.body.sessionId === sid, { status: ctxR.status, state: ctxR.body.sessionState, code: ctxR.body.code });
  const wrong = await call('GET', `/api/v1/agent/sessions/${sid}/context`, { caller: wsCaller('s0000000000a0') });
  check('agent context: another session name is refused (SESSION_MISMATCH)', wrong.status === 403 && wrong.body.code === 'SESSION_MISMATCH', { status: wrong.status, code: wrong.body.code });
  const ready = await waitState(sid, ['READY', 'RUNNING', 'FAILED', 'ENDING', 'ENDED', 'CLEANUP_FAILED'], 240_000);
  if (ready.state !== 'READY' && ready.state !== 'RUNNING') {
    const st = await call('GET', '/__dev/state');
    must('session reached READY', false, { state: ready.state, stateReason: ready.stateReason, healthReports, failure: (await rt.deps.db.send(new (await import('@aws-sdk/lib-dynamodb')).GetCommand({ TableName: rt.env.tableName, Key: Keys.labSession(sid) }))).Item?.failure, executions: (st.body.executions as unknown[] | undefined)?.slice(-3) });
  }
  const trail = await stateTrail(rt, sid);
  check('REQUESTED → PROVISIONING → READY', trail.join('>').includes('REQUESTED>PROVISIONING>READY'), trail.join(' → '));
  const ops = rt.runner.list().map((b) => b.op);
  check('runner: base-deploy, workstation-up, profile-apply', (['base-deploy', 'workstation-up', 'profile-apply'] as const).every((o) => ops.includes(o)) && rt.runner.list().every((b) => b.status === 'SUCCEEDED'), rt.runner.list().map((b) => `${b.op}:${b.status}`));
  const envId = String(ready.env && (ready.env as { envId?: string }).envId);
  const devEnv = rt.envs.get(envId);
  must('local CloudAlbum L0 of the environment is running', !!devEnv?.baseUrl, devEnv);
  const health = await fetch(`${devEnv!.baseUrl}/api/health/ready`).then((r) => r.status).catch(() => 0);
  check('local L0 /api/health/ready', health === 200, `${devEnv!.baseUrl} → ${health}`);
  const ps = cliJson(path.join(devEnv!.root!, 'etc'), ['platform-status', '--json']);
  const psSession = (ps.session ?? {}) as { sessionId?: string; labId?: string };
  check('local L0 runs in platform mode: cloudalbum platform-status (06 PM-02)', ps.platformMode === 'on' && psSession.sessionId === sid && (ps.probeToken as { present?: boolean } | undefined)?.present === true, { platformMode: ps.platformMode, session: ps.session, probeToken: ps.probeToken });
  const gate = healthReports[healthReports.length - 1] as { status?: string; report?: { devWaived?: string[] } } | undefined;
  check('health gate ran through ATL-RunCheck on the local L0 (base.ready, caps.profile, ws.ready)', gate?.status === 'PASS', { status: gate?.status, devWaived: gate?.report?.devWaived ?? [] });
  check('reclaim account: toolchain + ec2 stacks, workstation stack', [...rt.reclaim.stacks.values()].filter((x) => x.status !== 'DELETE_COMPLETE').length >= 3, [...rt.reclaim.stacks.keys()]);
  const schedules = rt.scheduler.list().map((x) => x.name);
  check('countdown schedules w15 / w5 / exp', ['w15', 'w5', 'exp'].every((k) => schedules.some((n) => n.includes(`-${k}-`))), schedules);
  check('deadline = readyAt + 90 min, whole minute', Date.parse(String(ready.deadlineAt)) - Date.parse(String(ready.readyAt)) >= 90 * 60_000 && Date.parse(String(ready.deadlineAt)) % 60_000 === 0, { readyAt: ready.readyAt, deadlineAt: ready.deadlineAt });
  const hb = await call('POST', `/api/v1/sessions/${sid}/heartbeat`, { token: LEARNER, body: { workbench: true } });
  check('heartbeat (workbench) → RUNNING', hb.status === 200 && hb.body.state === 'RUNNING', hb.body);
  const ws = await call('GET', `/api/v1/sessions/${sid}/workspace`, { token: LEARNER });
  check('GET /workspace', ws.status === 200, { tabs: ws.body.tabs ?? null, targets: (ws.body.targets as unknown[] | undefined)?.length ?? null });
  return sid;
}

// ---------------------------------------------------------------------------------------------------------------
// phase 2w: the workspace channels in dev mode (03 §3, §5, §6; platform-backend-gaps)

interface SsmClientModule {
  SsmTerminalConnection: new (o: Record<string, unknown>) => {
    readonly state: string;
    start(): Promise<void>;
    sendInput(data: string): boolean;
    close(): void;
  };
}

async function phaseWorkspace(c: Ctx, sid: string): Promise<void> {
  phase = '2w';
  const ws = await call('GET', `/api/v1/sessions/${sid}/workspace`, { token: LEARNER });
  const targets = (ws.body.targets as { tab?: string; ssmPing?: string; cached?: boolean }[] | undefined) ?? [];
  check('workspace targets discovered live (lab + workstation, Online)', targets.length === 2 && targets.every((t) => t.ssmPing === 'Online' && t.cached === false), targets);
  // terminal: POST …/terminals → the @atl/ssm-client mock → the real protocol client types into the fake shell
  const ssm = (await import(pathToFileURL(path.join(REPO_ROOT, 'platform', 'ssm-client', 'src', 'index.ts')).href)) as SsmClientModule;
  let terminalId = '';
  const out: string[] = [];
  const conn = new ssm.SsmTerminalConnection({
    clientId: 'smoke-tab',
    streamUrlPolicy: { allowLoopback: true },
    open: async () => {
      const r = await call('POST', `/api/v1/sessions/${sid}/terminals`, { token: LEARNER, body: { target: 'lab', cols: 100, rows: 30, clientId: 'smoke-tab' } });
      check('POST /terminals → 201 (StreamUrl of the mock, clientVersion)', r.status === 201 && String(r.body.streamUrl).startsWith('ws://127.0.0.1:') && r.body.clientVersion === '1.2.896.0', { status: r.status, code: r.body.code, document: r.body.document });
      terminalId = String(r.body.terminalId);
      return { streamUrl: String(r.body.streamUrl), tokenValue: String(r.body.tokenValue), connectBy: String(r.body.connectBy) };
    },
    resume: async () => {
      const r = await call('POST', `/api/v1/sessions/${sid}/terminals/${terminalId}/resume`, { token: LEARNER, body: { clientId: 'smoke-tab' } });
      return { streamUrl: String(r.body.streamUrl), tokenValue: String(r.body.tokenValue), connectBy: String(r.body.connectBy) };
    },
    onOutput: (data: Uint8Array, done: () => void) => {
      out.push(Buffer.from(data).toString('utf8'));
      done();
    },
  });
  const until = async (pred: () => boolean, ms = 10_000) => {
    const t0 = Date.now();
    while (!pred() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 25));
    return pred();
  };
  await conn.start().catch(() => undefined);
  check('terminal: handshake → ready (ATL-SessionShell over the mock data channel)', await until(() => conn.state === 'ready'), conn.state);
  conn.sendInput('echo atl-smoke-terminal\n');
  check('terminal: input and output (fake shell echo)', await until(() => out.join('').split('atl-smoke-terminal').length > 2), out.join('').slice(-200));
  const res = await call('POST', `/api/v1/sessions/${sid}/terminals/${terminalId}/resume`, { token: LEARNER, body: { clientId: 'smoke-tab' } });
  check('POST /terminals/{id}/resume → 200 (ResumeSession)', res.status === 200 && typeof res.body.tokenValue === 'string', { status: res.status, code: res.body.code });
  const del = await call('DELETE', `/api/v1/sessions/${sid}/terminals/${terminalId}`, { token: LEARNER });
  check('DELETE /terminals/{id} → 204, the client receives channel_closed', del.status === 204 && (await until(() => conn.state === 'closed')), { status: del.status, state: conn.state });
  conn.close();
  // console: AssumeRole (dev) → federation stub → POST login form
  const link = await call('POST', `/api/v1/sessions/${sid}/console-link`, { token: LEARNER, body: { linkId: 'ec2.instance' } });
  const form = link.body.form as { action?: string; fields?: Record<string, string> } | undefined;
  const login = form?.action ? await fetch(form.action, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form.fields ?? {}).toString() }) : null;
  check(
    'console-link → federation stub login (atl-<sid>-console, deep link of the registry)',
    link.status === 200 && login?.status === 200 && link.body.roleSessionName === `atl-${sid}-console` && String(form?.fields?.Destination).includes('/ec2/home'),
    { status: link.status, code: link.body.code, login: login?.status, destination: form?.fields?.Destination },
  );
  // app credentials: the local L0's administrator (06 PM-36)
  const cred = await call('GET', `/api/v1/sessions/${sid}/app-credentials`, { token: LEARNER });
  const envRec = c.rt.envs.list().find((e) => !!e.root && !!e.baseUrl);
  const pwFile = envRec?.root ? path.join(envRec.root, 'etc', 'atl', 'app-admin-password') : null;
  const expected = pwFile && fs.existsSync(pwFile) ? fs.readFileSync(pwFile, 'utf8').trim() : null;
  check('app-credentials → the local L0 administrator password', cred.status === 200 && !!expected && cred.body.password === expected, { status: cred.status, username: cred.body.username });
  if (expected && typeof cred.body.username === 'string' && envRec?.baseUrl) {
    const lr = await fetch(`${envRec.baseUrl}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: cred.body.username, password: expected }) })
      .then((r) => r.status)
      .catch(() => 0);
    check('the administrator signs in to the local CloudAlbum with these credentials', lr === 200, lr);
  }
  const pv = await call('GET', `/api/v1/sessions/${sid}/preview`, { token: LEARNER });
  const direct = ((pv.body.targets as { id: string; reason?: string }[] | undefined) ?? []).find((t) => t.id === 'direct');
  check('preview: the local L0 entry is http → MIXED_CONTENT (new tab only)', pv.status === 200 && direct?.reason === 'MIXED_CONTENT', pv.body.targets);
}

// ---------------------------------------------------------------------------------------------------------------
// phase 3: step 1 checks

async function runStepChecks(sid: string, stepId: string): Promise<Record<string, unknown>> {
  const r = await call('POST', `/api/v1/sessions/${sid}/steps/${stepId}/check-runs`, { token: LEARNER, body: {} });
  must(`check run of step ${stepId} accepted`, r.status === 202 && typeof r.body.runId === 'string', r.body);
  const runId = String(r.body.runId);
  return until(`check run ${runId}`, async () => {
    const g = await call('GET', `/api/v1/sessions/${sid}/check-runs/${runId}`, { token: LEARNER });
    const st = String(g.body.state ?? g.body.status ?? '');
    return ['completed', 'failed', 'error', 'done', 'COMPLETED'].includes(st) ? g.body : null;
  }, 120_000, 500);
}

async function phaseChecks(c: Ctx, sid: string): Promise<void> {
  phase = '3';
  const run1 = await runStepChecks(sid, 'orient');
  const results = (run1.results as { checkId?: string; checkKey?: string; type?: string; status?: string; result?: string; errorCode?: string }[] | undefined) ?? [];
  const byId = (id: string) => results.find((x) => String(x.checkKey ?? x.checkId).endsWith(id));
  const statusOf = (x: { status?: string; result?: string } | undefined) => String(x?.result ?? x?.status ?? 'missing');
  check('capability check storage-local-baseline: pass (driver local, module off, local health ok)', statusOf(byId('storage-local-baseline')) === 'pass', byId('storage-local-baseline'));
  check('local check data-volume-usage (ATL-RunCheck disk-usage on the lab instance): pass', statusOf(byId('data-volume-usage')) === 'pass', byId('data-volume-usage'));
  const steps = await call('GET', `/api/v1/sessions/${sid}/steps`, { token: LEARNER });
  const orient = ((steps.body.items as { stepId: string; state: string }[] | undefined) ?? []).find((s) => s.stepId === 'orient');
  check('step 1 (orient) is done', orient?.state === 'done' || orient?.state === 'passed', orient);
  void c;
}

// ---------------------------------------------------------------------------------------------------------------
// phase 4: manual confirmation

async function phaseManual(c: Ctx, sid: string): Promise<void> {
  phase = '4';
  const r = await call('POST', `/api/v1/sessions/${sid}/steps/observe-direct-upload/manual-confirmations`, {
    token: LEARNER,
    body: { checkId: 'put-target-answer', observed: 's3', note: 'DevTools 中上传 PUT 的主机是 S3 区域端点（smoke）' },
  });
  check('manual confirmation put-target-answer accepted', r.status === 202 || r.status === 201 || r.status === 200, { status: r.status, body: r.body });
  const cid = String(r.body.confirmationId ?? '');
  if (cid) {
    const rv = await call('POST', `/api/v1/sessions/${sid}/manual-confirmations/${cid}/review`, { token: ASSISTANT, body: { decision: 'approve', comment: 'smoke' } });
    check('assistant review of the confirmation', rv.status === 200 || rv.status === 202, { status: rv.status, code: rv.body.code });
  }
  const step = await until('manual result folded into the step', async () => {
    const steps = await call('GET', `/api/v1/sessions/${sid}/steps`, { token: LEARNER });
    const s = ((steps.body.items as Record<string, unknown>[] | undefined) ?? []).find((x) => x.stepId === 'observe-direct-upload');
    const checks = (s?.checks ?? {}) as Record<string, { lastManual?: unknown }>;
    const k = Object.keys(checks).find((x) => x.endsWith('put-target-answer'));
    return k && checks[k]?.lastManual ? s : null;
  }, 30_000, 500).catch(() => null);
  check('StepResult carries the manual result (lastManual)', !!step, step ? { state: step.state } : null);
  void c;
}

// ---------------------------------------------------------------------------------------------------------------
// phase 5: comparison experiment upload-burst (before / after)

function cliJson(etc: string, args: string[]): Record<string, unknown> {
  const r = run(process.execPath, [path.join(REPO_ROOT, 'backend', 'dist', 'cli.js'), ...args], { env: childEnv({ CLOUDALBUM_ENV_DIR: etc, NODE_ENV: 'development' }), timeoutMs: 60_000 });
  const last = r.stdout.trim().split(/\r?\n/).pop() ?? '';
  try {
    return JSON.parse(last) as Record<string, unknown>;
  } catch {
    throw new PhaseFailed(`cloudalbum ${args[0]}: ${r.stderr || r.stdout}`);
  }
}

async function phaseExperiment(c: Ctx, sid: string): Promise<void> {
  phase = '5';
  const { rt } = c;
  const view = await session(sid);
  const envId = String((view.env as { envId?: string }).envId);
  const devEnv = rt.envs.get(envId)!;
  const etc = path.join(devEnv.root!, 'etc');
  const tok = cliJson(etc, ['lab-token', '--ttl', '3600', '--json']);
  must('cloudalbum lab-token (atllt1, PM-17) on the lab instance', typeof tok.token === 'string' && String(tok.token).startsWith('atllt1.'), Object.keys(tok));
  const runs: { label: string; runId: string }[] = [];
  for (const label of ['before', 'after']) {
    const reg = await call('POST', `/api/v1/agent/sessions/${sid}/experiment-runs`, { caller: wsCaller(sid), body: { module: 'storage', experiment: 'upload-burst', label } });
    must(`register upload-burst/${label} (agent route)`, reg.status === 201 && typeof reg.body.runId === 'string', reg.body);
    const runId = String(reg.body.runId);
    runs.push({ label, runId });
    // the experiment runner on the workstation: register the run with the app, drive traffic with X-Experiment-Run, finish
    const variant = reg.body.variant as Record<string, unknown>;
    const ar = await fetch(`${devEnv.baseUrl}/api/lab/runs`, {
      method: 'POST',
      headers: { authorization: `CA-Lab ${String(tok.token)}`, 'content-type': 'application/json' },
      body: JSON.stringify({ runId, module: 'storage', experiment: 'upload-burst', label, variant }),
    });
    check(`app registers run ${label} (POST /api/lab/runs, CA-Lab)`, ar.status === 201, `${ar.status} ${(await ar.text()).slice(0, 200)}`);
    const startedAt = rt.clock.now().toISOString();
    let ok = 0;
    const n = 24;
    const lat: number[] = [];
    for (let i = 0; i < n; i++) {
      const t0 = Date.now();
      const r = await fetch(`${devEnv.baseUrl}/api/feed?scope=public&limit=5`, { headers: { 'x-experiment-run': runId, 'x-experiment-label': label } });
      await r.arrayBuffer();
      lat.push(Date.now() - t0);
      if (r.status < 400) ok++;
    }
    await fetch(`${devEnv.baseUrl}/api/lab/runs/${runId}/finish`, { method: 'POST', headers: { authorization: `CA-Lab ${String(tok.token)}`, 'content-type': 'application/json' }, body: '{}' });
    const finishedAt = rt.clock.now().toISOString();
    lat.sort((a, b) => a - b);
    const result: Record<string, unknown> = {
      schema: 'atl.experiment-result/v1',
      baseSchema: 'cloudalbum.result/v1',
      runId,
      sessionId: sid,
      labId: LAB,
      module: 'storage',
      experiment: 'upload-burst',
      label,
      variant,
      forced: false,
      ab: false,
      startedAt,
      finishedAt,
      target: devEnv.baseUrl,
      targets: [{ kind: 'direct', url: devEnv.baseUrl }],
      params: { vus: 1, duration: `${n}req`, repeat: 1, ab: false },
      client: { requests: n, errors: n - ok, latencyMs: { p50: lat[Math.floor(n / 2)], p95: lat[Math.floor(n * 0.95)] }, byTarget: { direct: { requests: n } } },
      environment: { profile: `atl/${LAB}/default`, drivers: { storage: 'local' } },
      notes: 'smoke:platform (dev): GET /api/feed with X-Experiment-Run',
    };
    // the app flushes its lab metrics every 10 s
    await sleep(11_000);
    const body = { ...result, integrity: { canonicalization: 'RFC8785', digest: `sha256:${createHash('sha256').update(canonicalJson(result)).digest('hex')}` } };
    const up = await call('PUT', `/api/v1/agent/sessions/${sid}/experiment-runs/${runId}/result`, { caller: wsCaller(sid), body });
    check(`upload result ${label} (RFC 8785 digest) → corroborating`, up.status === 202 && up.body.status === 'corroborating', up.body);
  }
  // poll the platform's cross-check (registration → upload → poll, 04 §7.4)
  const verdicts: Record<string, unknown> = {};
  for (const r of runs) {
    const v = await until(`validity of ${r.label}`, async () => {
      const g = await call('GET', `/api/v1/agent/sessions/${sid}/experiment-runs/${r.runId}`, { caller: wsCaller(sid) });
      const st = (g.body.validity as { status?: string } | undefined)?.status;
      return st && st !== 'pending-crosscheck' ? g.body.validity : null;
    }, 90_000, 1000).catch(() => null);
    verdicts[r.label] = v;
  }
  check('before (requires storage=local, served by the local L0): valid — server-side corroboration through lab-metrics', (verdicts.before as { status?: string } | null)?.status === 'valid', verdicts.before);
  check('after (requires storage=s3): invalid with DRIVER_MISMATCH on the local L0 (the target module needs AWS)', (verdicts.after as { status?: string; reasons?: string[] } | null)?.status === 'invalid', verdicts.after);
  const list = await call('GET', `/api/v1/sessions/${sid}/experiment-runs`, { token: LEARNER });
  check('GET /sessions/{sid}/experiment-runs lists both runs', ((list.body.items as unknown[]) ?? []).length === 2);
}

// ---------------------------------------------------------------------------------------------------------------
// phase 6: extend → fast-forward → EXPIRING → ENDING → CLEANING → ENDED

async function phaseExpire(c: Ctx, sid: string): Promise<void> {
  phase = '6';
  const { rt } = c;
  const before = await session(sid);
  const q = await call('POST', `/api/v1/sessions/${sid}/quotes`, { token: LEARNER, body: { purpose: 'EXTEND', minutes: 30 } });
  must('quote EXTEND 30 min', (q.status === 201 || q.status === 200) && typeof q.body.quoteId === 'string', { status: q.status, body: q.body });
  const ext = await call('POST', `/api/v1/sessions/${sid}/extend`, { token: LEARNER, body: { minutes: 30, quoteId: q.body.quoteId, expectedDeadlineVersion: before.deadlineVersion } });
  const after = await session(sid);
  check('extend once: deadline +30 min, deadlineVersion 2', ext.status === 200 && Date.parse(String(after.deadlineAt)) - Date.parse(String(before.deadlineAt)) === 30 * 60_000 && after.deadlineVersion === 2, {
    status: ext.status,
    code: ext.body.code,
    deadlineAt: after.deadlineAt,
    deadlineVersion: after.deadlineVersion,
  });
  const schedules = rt.scheduler.list().map((x) => x.name);
  check('re-armed v2 schedules', schedules.some((n) => n.includes('-exp-v2')) && !schedules.some((n) => n.includes('-exp-v1')), schedules);
  const envId = String((after.env as { envId?: string }).envId);
  const baseUrl = rt.envs.get(envId)?.baseUrl ?? null;
  // fast-forward to 16 minutes before the deadline: the w15 schedule fires → EXPIRING (T08)
  const deadline = Date.parse(String(after.deadlineAt));
  const toW15 = deadline - 16 * 60_000 - rt.clock.nowMs();
  if (toW15 > 0) clockOf(rt).skip(toW15);
  log(`clock skipped ${Math.round(toW15 / 60_000)} platform minutes; waiting for w15 …`);
  const exp = await waitState(sid, ['EXPIRING'], 60_000).catch(() => null);
  must('w15 schedule → EXPIRING', exp?.state === 'EXPIRING', exp ? { state: exp.state } : await session(sid));
  const evs = await until('session.expiry_warning event', async () => {
    const e = await events(sid);
    return e.some((x) => x.type === 'session.expiry_warning') ? e : null;
  }, 30_000, 1000).catch(() => []);
  check('EXPIRING reminder (session.expiry_warning)', evs.some((x) => x.type === 'session.expiry_warning'));
  clockOf(rt).skip(deadline - rt.clock.nowMs() + 1000);
  log('clock skipped to the deadline; waiting for ENDING → CLEANING → ENDED …');
  const ended = await waitState(sid, ['ENDED', 'CLEANUP_FAILED', 'FAILED'], 300_000);
  const trail = await stateTrail(rt, sid);
  check('exp schedule → ENDING → CLEANING → ENDED (endReason EXPIRED)', ended.state === 'ENDED' && /EXPIRING>ENDING>CLEANING>ENDED$/.test(trail.join('>')), { trail: trail.join(' → '), endReason: (ended as { endReason?: string }).endReason ?? ended.stateReason });
  const live = [...rt.reclaim.stacks.values()].filter((x) => x.status !== 'DELETE_COMPLETE').map((x) => x.name);
  check('reclaimer: every stack of the environment deleted (dev account empty)', live.length === 0 && rt.reclaim.resources.size === 0, { live, resources: [...rt.reclaim.resources.keys()] });
  const down = baseUrl ? await fetch(`${baseUrl}/api/health/live`).then(() => false).catch(() => true) : true;
  check('local L0 of the environment stopped', down && !rt.l0.isRunning(envId), baseUrl);
  const cleanup = await call('GET', `/api/v1/sessions/${sid}/cleanup`, { token: LEARNER });
  check('GET /cleanup: reclaim report', cleanup.status === 200, { status: cleanup.body.status, items: (cleanup.body.items as unknown[] | undefined)?.length });
  const rescan = rt.orchestrator.sim.listExecutions().some((x) => x.executionArn.includes(':atl-reclaim-rescan:'));
  check('delayed rescans scheduled (atl-reclaim-rescan)', rescan);
}

// ---------------------------------------------------------------------------------------------------------------
// phase 7: report → completion → badge → certificate → verification → revocation

async function loadVerifyPage(rt: DevRuntime): Promise<(jws: string) => Promise<{ status: string; texts: Record<string, string> }>> {
  const js = await rt.objects.get(rt.env.buckets.web, `${WebKeys.verify}verify.js`);
  if (!js) throw new PhaseFailed('verify/verify.js is not published');
  const source = Buffer.from(js).toString('utf8');
  return async (jws: string) => {
    const texts: Record<string, string> = {};
    const el = (id: string) => ({
      set textContent(v: string) {
        texts[id] = v;
      },
      set className(v: string) {
        texts[`${id}.class`] = v;
      },
      appendChild: () => undefined,
    });
    const webFetch = async (p: string) => {
      const b = await rt.objects.get(rt.env.buckets.web, p.replace(/^\//, ''));
      return { ok: !!b, text: async () => (b ? Buffer.from(b).toString('utf8') : '') };
    };
    const sandbox = {
      crypto: webcrypto,
      TextEncoder,
      TextDecoder,
      atob,
      URLSearchParams,
      console,
      fetch: webFetch,
      location: { pathname: '/verify/', hash: `#jws=${jws}` },
      document: { getElementById: el, createElement: () => ({ textContent: '' }) },
      localStorage: { getItem: () => null, setItem: () => undefined },
    };
    vm.runInNewContext(source, sandbox, { filename: 'verify.js' });
    await until('verify page result', async () => (texts['result.class'] ? true : null), 10_000, 50);
    return { status: texts['result.class']!.replace(/^status /, ''), texts };
  };
}

/** 04 §9.4 / §9.5: the masked export and a share link (create → listed active → revoke), as 07 stage 5 exercises them. */
async function phaseReportExportAndShare(c: Ctx, sid: string): Promise<void> {
  const { rt } = c;
  const exp = await until('masked export', async () => {
    const r = await call('GET', `/api/v1/sessions/${sid}/report/export?format=json`, { token: LEARNER });
    return r.status === 200 ? r.body : null;
  }, 60_000, 500).catch(() => null);
  const expUrl = (exp?.download as { url?: string } | undefined)?.url ?? '';
  const expDoc = expUrl.startsWith('file:') ? fs.readFileSync(new URL(expUrl), 'utf8') : '';
  check('report export (mask=on): atl-certs rendered a masked copy in exports/ and atl-api signed only that copy', expUrl.includes('exports') && expDoc.includes('masked copy') && !expDoc.includes(rt.env.accountId), { status: exp?.status, url: expUrl.slice(-80) });
  const sh = await call('POST', `/api/v1/sessions/${sid}/report/shares`, { token: LEARNER, body: { expiresInDays: 7 } });
  const shareId = String(sh.body.shareId ?? '');
  check('POST /report/shares → 202 with the real link (/share/<22-char id>/index.html)', sh.status === 202 && /^[A-Za-z0-9_-]{22}$/.test(shareId) && sh.body.url === `/share/${shareId}/index.html`, sh.body);
  const listed = async (status: string) => {
    const l = await call('GET', `/api/v1/sessions/${sid}/report/shares`, { token: LEARNER });
    return ((l.body.items as { shareId: string; status: string }[] | undefined) ?? []).find((i) => i.shareId === shareId && i.status === status) ?? null;
  };
  const active = await until('share active', () => listed('active'), 60_000, 500).catch(() => null);
  const html = await rt.objects.get(rt.env.buckets.web, `${WebKeys.share(shareId)}index.html`);
  const scheduled = rt.scheduler.list().some((x) => x.name === ScheduleNames.shareExpire(shareId));
  check('share copy published to atl-web/share/<id>/, listed active, expiry schedule atl-share-<id>-exp created', !!active && !!html && scheduled, { active, html: !!html, scheduled });
  const del = await call('DELETE', `/api/v1/sessions/${sid}/report/shares/${shareId}`, { token: LEARNER });
  const revoked = await until('share revoked', () => listed('revoked'), 60_000, 500).catch(() => null);
  const gone = !(await rt.objects.get(rt.env.buckets.web, `${WebKeys.share(shareId)}index.html`));
  const unscheduled = !rt.scheduler.list().some((x) => x.name === ScheduleNames.shareExpire(shareId));
  check('DELETE /report/shares/{id} revokes it: copy deleted, schedule deleted, listed revoked', del.status === 202 && !!revoked && gone && unscheduled, { status: del.status, revoked, gone, unscheduled });
}

async function phaseReportAndCertificate(c: Ctx, sid: string): Promise<void> {
  phase = '7';
  const { rt } = c;
  // the end workflow ran FinalizeAttempt and atl-certs GenerateReport (revision 1, then the cleanup revision)
  const rep = await until('report', async () => {
    const r = await call('GET', `/api/v1/sessions/${sid}/report`, { token: LEARNER });
    return r.status === 200 ? r.body : null;
  }, 60_000, 1000).catch(() => null);
  check('report generated by the end workflow (atl-certs GenerateReport)', !!rep && Number(rep.version ?? rep.revision ?? 0) >= 1, rep ? { version: rep.version, status: rep.status, attempt: rep.attemptStatus ?? null } : null);
  const gen = await call('POST', `/api/v1/sessions/${sid}/report`, { token: LEARNER, body: {} });
  check('POST /report (regenerate) accepted', gen.status === 202, gen.body);
  const json = rep ? ((rep.downloads as Record<string, { url?: string }> | undefined)?.json?.url ?? null) : null;
  if (json) {
    const local = json.startsWith('file:') ? fs.readFileSync(new URL(json), 'utf8') : null;
    const doc = local ? (JSON.parse(local) as Record<string, unknown>) : null;
    check('report JSON (atl.report/v1) records the checks, manual confirmation and experiments', !!doc && String(doc.schema).startsWith('atl.report/'), doc ? Object.keys(doc).slice(0, 12) : null);
  }
  await phaseReportExportAndShare(c, sid);
  const progress = await call('GET', '/api/v1/me/progress', { token: LEARNER });
  const mine = ((progress.body.labs ?? progress.body.items) as { labId: string; status: string; badge?: unknown }[] | undefined) ?? [];
  const storage = mine.find((p) => p.labId === LAB);
  check(`svc-storage attempt recorded in LabProgress (real FinalizeAttempt: ${storage?.status ?? 'none'})`, !!storage, storage);
  // dev fixture (task: “dev 模式下允许用测试夹具补齐其余卡片的完成记录”): completion + verified badges for the required
  // cards of quick-compare. svc-storage's target step (storage=s3, bucket checks) needs a real S3 bucket, so the local L0
  // cannot complete it; its completion record is part of the fixture as well (its real attempt above is kept as attempt 1).
  const nowIso = rt.clock.now().toISOString();
  const required = ['svc-storage', 'svc-cdn', 'svc-queue', 'svc-image-processing', 'svc-auth', 'svc-cache', 'svc-database'];
  const { PutCommand, GetCommand } = await import('@aws-sdk/lib-dynamodb');
  for (const labId of required) {
    const cur = (await rt.deps.db.send(new GetCommand({ TableName: rt.env.tableName, Key: Keys.labProgress(SUB, labId) }))).Item ?? {};
    const attemptId = labId === LAB ? sid : `sfx${createHash('sha256').update(labId).digest('hex').replace(/[^0-9a-hjkmnp-tv-z]/g, '').slice(0, 10)}`;
    await rt.deps.db.send(
      new PutCommand({
        TableName: rt.env.tableName,
        Item: {
          ...cur,
          ...Keys.labProgress(SUB, labId),
          type: 'LabProgress',
          sub: SUB,
          labId,
          kind: 'service',
          ver: Number(cur.ver ?? 0) + 1,
          createdAt: cur.createdAt ?? nowIso,
          updatedAt: nowIso,
          status: 'completed',
          attempts: Number(cur.attempts ?? 0) + (labId === LAB ? 0 : 1),
          attemptIds: [...((cur.attemptIds as string[] | undefined) ?? []), ...(labId === LAB ? [] : [attemptId])],
          bestAttemptId: attemptId,
          firstCompletedAt: nowIso,
          badge: { level: 'verified', status: 'valid', earnedAt: nowIso, attemptId, labVersion: '1.0.0', variant: 'default', evidenceScore: 0.95, fixture: 'smoke:platform' },
          credits: [],
          regressions: [],
          quizByService: {},
        },
      }),
    );
  }
  check('dev fixture: completion records + verified badges for the 7 required quick-compare cards', true, required.join(', '));
  const tr = await call('GET', `/api/v1/tracks/${TRACK}`, { token: LEARNER });
  const tp = (tr.body.progress ?? {}) as { completed?: boolean; eligible?: boolean; certificate?: { eligible?: boolean } };
  check('track quick-compare: completed and certificate-eligible', tp.completed === true || tp.eligible === true || tp.certificate?.eligible === true, tp);
  const issued = await call('POST', '/api/v1/certificates', { token: LEARNER, body: { scope: 'track', trackId: TRACK } });
  must('POST /certificates (quick-compare) → 201 with a JWS (atl-certs, dev ECDSA P-256 = KMS DIGEST stand-in)', issued.status === 201 && typeof issued.body.jws === 'string', issued.body);
  const certId = String(issued.body.certId);
  const jws = String(issued.body.jws);
  const [h] = jws.split('.');
  const header = JSON.parse(Buffer.from(h!, 'base64url').toString('utf8')) as { alg?: string; typ?: string; kid?: string };
  check('JWS header: ES256, atl-cert+jws, kid = JWK thumbprint', header.alg === 'ES256' && header.typ === 'atl-cert+jws' && typeof header.kid === 'string', header);
  // offline verification tool (04 §10.5): node verify.mjs bundle.json
  const bundleRes = await call('GET', `/api/v1/certificates/${certId}/offline-bundle`, { token: LEARNER });
  must('offline bundle', bundleRes.status === 200 && typeof bundleRes.body.verifyScript === 'string', { status: bundleRes.status, code: bundleRes.body.code });
  const offline = (bundle: Record<string, unknown>) => {
    const dir = path.join(DATA_DIR, 'offline');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'verify.mjs'), String(bundle.verifyScript));
    fs.writeFileSync(path.join(dir, 'cert.json'), JSON.stringify(bundle));
    const r = run(process.execPath, [path.join(dir, 'verify.mjs'), path.join(dir, 'cert.json')], { cwd: dir, timeoutMs: 30_000 });
    return { exit: r.status, out: (() => {
      try {
        return JSON.parse(r.stdout) as { status?: string };
      } catch {
        return { status: `unparsable: ${r.stdout}${r.stderr}` };
      }
    })() };
  };
  const ok1 = offline(bundleRes.body);
  check('offline tool: valid (exit 0)', ok1.exit === 0 && ok1.out.status === 'valid', ok1);
  const verifyPage = await loadVerifyPage(rt);
  const page1 = await verifyPage(jws);
  check('static verify page logic (verify/verify.js with jwks.json + revocations.jws): valid', page1.status === 'valid', page1.texts);
  const tampered = `${jws.split('.')[0]}.${Buffer.from(JSON.stringify({ forged: true })).toString('base64url')}.${jws.split('.')[2]}`;
  check('verify page: a tampered payload is rejected', (await verifyPage(tampered)).status !== 'valid');
  const pub = await call('GET', `/api/v1/public/certificates/${certId}`);
  check('public status route', pub.status === 200 && pub.body.status === 'valid', pub.body);
  // revoke → both verifiers fail
  const rv = await call('POST', `/api/v1/certificates/${certId}/revoke`, { token: LEARNER, body: { reason: 'learner-request' } });
  check('POST /certificates/{id}/revoke', rv.status === 200 && rv.body.status === 'revoked', rv.body);
  const bundle2 = await call('GET', `/api/v1/certificates/${certId}/offline-bundle`, { token: LEARNER });
  const ok2 = offline(bundle2.body);
  check('offline tool after revocation: revoked (exit 1)', ok2.exit === 1 && ok2.out.status === 'revoked', ok2);
  const page2 = await verifyPage(jws);
  check('verify page after revocation: revoked (signed revocation list)', page2.status === 'revoked', page2.texts);
  const pub2 = await call('GET', `/api/v1/public/certificates/${certId}`);
  check('public status route: revoked', pub2.body.status === 'revoked', pub2.body);
}

// ---------------------------------------------------------------------------------------------------------------
// phase 8: failure path — reclaim fault → CLEANUP_FAILED → manual list → “我已处理” → re-check → ENDED

async function phaseCleanupFailure(c: Ctx): Promise<string> {
  phase = '8';
  const { rt } = c;
  const q = await call('POST', `/api/v1/labs/${LAB}/quotes`, { token: LEARNER, body: { purpose: 'START' } });
  const s = await call('POST', '/api/v1/sessions', { token: LEARNER, body: { labId: LAB, quoteId: q.body.quoteId, costAcknowledged: true } });
  must('second session started', s.status === 202, s.body);
  const sid = String(s.body.sessionId);
  const ready = await waitState(sid, ['READY', 'FAILED', 'ENDED'], 240_000);
  must('second session READY', ready.state === 'READY', { state: ready.state, reason: ready.stateReason });
  await call('POST', `/api/v1/sessions/${sid}/heartbeat`, { token: LEARNER, body: { workbench: true } });
  const envName = String((ready.env as { envName?: string }).envName);
  // fault injection: the learner created a DB instance in the console that cannot be deleted (deletion protection)
  const region = rt.env.region;
  const id = `cloudalbum-${envName}-db-protected`;
  rt.reclaim.addResource({ type: 'AWS::RDS::DBInstance', region, id, behaviour: { kind: 'protected' } });
  const at = new Date(rt.clock.nowMs() - 60_000).toISOString();
  rt.trail.inject({
    eventId: `ev-${id}`,
    eventName: 'CreateDBInstance',
    eventTime: at,
    eventSource: 'rds.amazonaws.com',
    region,
    username: `atl-${sid}-console`,
    readOnly: false,
    resources: [{ resourceType: 'AWS::RDS::DBInstance', resourceName: id }],
    cloudTrailEvent: JSON.stringify({
      eventID: `ev-${id}`,
      eventName: 'CreateDBInstance',
      eventSource: 'rds.amazonaws.com',
      awsRegion: region,
      eventTime: at,
      userIdentity: { type: 'AssumedRole', arn: `arn:aws:sts::000000000000:assumed-role/ATLLearnerRole/atl-${sid}-console`, sessionContext: { sessionIssuer: { arn: 'arn:aws:iam::000000000000:role/ATLLearnerRole' } } },
      requestParameters: { dBInstanceIdentifier: id },
      responseElements: { dBInstanceIdentifier: id, dBInstanceArn: `arn:aws:rds:${region}:000000000000:db:${id}` },
    }),
  });
  check('fault injected: undeletable learner resource (protected RDS instance + CloudTrail CreateDBInstance)', true, id);
  const end = await call('POST', `/api/v1/sessions/${sid}/end`, { token: LEARNER, body: { disposition: 'destroy', when: 'now' } });
  check('POST /end (destroy now)', end.status === 202, end.body);
  const failed = await waitState(sid, ['CLEANUP_FAILED', 'ENDED'], 300_000);
  check('reclaim fault → CLEANUP_FAILED', failed.state === 'CLEANUP_FAILED', { state: failed.state, cleanup: (failed as { cleanup?: unknown }).cleanup ?? null });
  const manual = await call('GET', '/api/v1/resources/manual', { token: LEARNER });
  check('manual-handling list (GET /resources/manual): 1 BLOCKING hourly item', Number(manual.body.total) === 1 && Number(manual.body.hourlyBlocking) === 1, { total: manual.body.total, hourlyBlocking: manual.body.hourlyBlocking });
  const rep = await call('GET', `/api/v1/sessions/${sid}/cleanup`, { token: LEARNER });
  const item = ((rep.body.items as { resourceKey: string; severity: string; type: string }[] | undefined) ?? []).find((i) => i.type === 'AWS::RDS::DBInstance');
  check('cleanup report lists the instance with a manual hint', !!item && item.severity === 'BLOCKING', item);
  const md = await fetch(`${BASE}/api/v1/sessions/${sid}/cleanup?format=md`, { headers: { authorization: `Bearer ${LEARNER}` } }).then((r) => r.text());
  check('cleanup report (markdown) carries the CLI to delete it', md.includes(id));
  // the learner deletes it by hand, then “我已处理” → atl-lifecycle ResolveCleanup → atl-reaper ResolveItem → T20
  rt.reclaim.resources.delete(`AWS::RDS::DBInstance|${region}|${id}`);
  const res = await call('POST', `/api/v1/sessions/${sid}/cleanup/items/${encodeURIComponent(item!.resourceKey)}/resolve`, { token: LEARNER, body: { note: '已在控制台关闭删除保护并删除（smoke）' } });
  check('POST …/cleanup/items/{resourceKey}/resolve → 202', res.status === 202, res.body);
  const ended = await waitState(sid, ['ENDED'], 60_000).catch(() => null);
  const trail = await stateTrail(rt, sid);
  check('re-check → ENDED (T20 RESOLVED_BY_LEARNER)', ended?.state === 'ENDED' && /CLEANUP_FAILED>ENDED$/.test(trail.join('>')), trail.join(' → '));
  const manual2 = await call('GET', '/api/v1/resources/manual', { token: LEARNER });
  check('manual-handling list is empty again', Number(manual2.body.total) === 0, { total: manual2.body.total });
  return sid;
}

// ---------------------------------------------------------------------------------------------------------------
// phase 9: uninstall guard

async function phaseUninstallGuard(c: Ctx): Promise<void> {
  phase = '9';
  const { rt } = c;
  const q = await call('POST', `/api/v1/labs/${LAB}/quotes`, { token: LEARNER, body: { purpose: 'START' } });
  const s = await call('POST', '/api/v1/sessions', { token: LEARNER, body: { labId: LAB, quoteId: q.body.quoteId, costAcknowledged: true } });
  must('third session started (non-terminal)', s.status === 202, s.body);
  const sid = String(s.body.sessionId);
  await waitState(sid, ['READY', 'RUNNING', 'FAILED'], 240_000);
  const before = c.cr.responses.length;
  // UninstallRoleCleanup asked to finish while the session runs → refused (FAILED to CloudFormation, nothing touched)
  const cb = { responseUrl: 'https://cloudformation-custom-resource-response.dev.invalid/uninstall', requestId: 'r-uninstall', stackId: 'arn:aws:cloudformation:ap-northeast-1:000000000000:stack/atl/x', logicalResourceId: 'UninstallGuard', physicalResourceId: 'atl-uninstallguard' };
  const { UpdateCommand } = await import('@aws-sdk/lib-dynamodb');
  await rt.deps.db.send(new UpdateCommand({ TableName: rt.env.tableName, Key: Keys.platformConfig(), UpdateExpression: 'SET #m = :u', ExpressionAttributeNames: { '#m': 'mode' }, ExpressionAttributeValues: { ':u': 'UNINSTALLING' } }));
  const rc = (await rt.invoker.invoke('atl-custom-resources' as LambdaFunctionName, { action: 'UninstallRoleCleanup', cfn: cb, outcome: 'SUCCESS', reason: 'smoke' })) as { status: string; reason: string };
  check('UninstallRoleCleanup refuses while a session is not terminal (FAILED, no role clean-up)', rc.status === 'FAILED' && /not finished/.test(rc.reason), rc);
  check('CloudFormation answered FAILED', c.cr.responses.length === before + 1 && c.cr.responses[before]!.status === 'FAILED', c.cr.responses.slice(before));
  const blocked = await call('POST', `/api/v1/labs/${LAB}/quotes`, { token: LEARNER, body: { purpose: 'START' } });
  const st = await call('POST', '/api/v1/sessions', { token: LEARNER, body: { labId: LAB, quoteId: blocked.body.quoteId ?? 'x', costAcknowledged: true } });
  check('UNINSTALLING: new sessions are refused', st.status === 409 || st.status === 400 || st.status === 503, { status: st.status, code: st.body.code });
  const status = await call('GET', '/api/v1/platform/uninstall/status', { token: LEARNER });
  check('GET /platform/uninstall/status shows the blocking session (ready: false)', status.status === 200 && status.body.ready === false, { ready: status.body.ready, blockers: status.body.blockers ?? status.body.sessions ?? null });
  // the guard's Delete path with a live session: no fast path, atl-platform-uninstall takes over (ends the session)
  await rt.deps.db.send(new UpdateCommand({ TableName: rt.env.tableName, Key: Keys.platformConfig(), UpdateExpression: 'SET #m = :n', ExpressionAttributeNames: { '#m': 'mode' }, ExpressionAttributeValues: { ':n': 'NORMAL' } }));
  const del = await customResource(c, 'UninstallGuard', 'Delete', { Table: rt.env.tableName, UninstallStateMachineArn: `arn:aws:states:${rt.env.region}:${rt.env.accountId}:stateMachine:atl-platform-uninstall` });
  check('UninstallGuard Delete with a live session: no fast path, CloudFormation not answered yet (PENDING)', del.status === 'PENDING', del);
  const execs = rt.orchestrator.sim.listExecutions().filter((x) => x.executionArn.includes(':atl-platform-uninstall:'));
  check('atl-platform-uninstall started by the guard', execs.length >= 1, execs.map((x) => x.executionArn.split(':').pop()));
  log('waiting for atl-platform-uninstall to end the session and answer CloudFormation …');
  const answered = await until('uninstall answered', async () => (c.cr.responses.length > before + 1 ? c.cr.responses[c.cr.responses.length - 1] : null), 300_000, 1000).catch(() => null);
  check('after the session is reclaimed: UninstallRoleCleanup answers SUCCESS', answered?.status === 'SUCCESS', answered);
  const s3 = await session(sid);
  check('the running session was ended by the uninstall (PLATFORM_UNINSTALL)', s3.state === 'ENDED', { state: s3.state, reason: s3.stateReason });
}

// ---------------------------------------------------------------------------------------------------------------

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error(e);
    process.exit(1);
  },
);
