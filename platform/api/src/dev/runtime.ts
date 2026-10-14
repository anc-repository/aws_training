/**
 * ATL_DEV_MODE=1 runtime: all ports backed by local implementations, all twelve functions in one process.
 *
 *   DynamoDB      → DynamoDB Local (docker-compose.platform.yml, `npm run platform:db:up` + `platform:db:init`)
 *   Step Functions→ in-process ASL simulator (same statemachines/*.asl.json, fault injection)
 *   CodeBuild     → LocalProcessRunner (noop | scripts/module --dry-run | local L0)
 *   Run Command   → LocalRunCommand (check runner as a local process against the local CloudAlbum)
 *   Scheduler     → in-process timers on the scaled dev clock (ATL_DEV_TIME_SCALE)
 *   KMS           → local ECDSA P-256 key
 *   CloudTrail    → injectable fake events
 *   Cognito       → dev tokens `dev.<group>.<sub>`
 *   Lambda/EventBridge/S3 → in-process table / memory bus / directories
 *
 * Integration wiring (docs/implementation-notes.md “platform-integration”): the API route tables (atl-api / atl-agent /
 * atl-public), the dev check engine of atl-checks (FakeAws + DevHttp → local CloudAlbum), the lifecycle dev clouds
 * (`installLifecycleDev`: IAM revocation / instance discovery / SSM and the in-memory reclaim “account”), and the
 * EventBridge rule of `atl-events` that the template defines (session.state_changed / reclaim.pass_completed →
 * atl-checks) are all installed here, so every dev entry point (platform:dev, dev-server.ts, smoke:platform) runs the
 * same runtime.
 *
 * Production code never imports this module (see aws/deps.ts for the production wiring).
 */
import fs from 'node:fs';
import path from 'node:path';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { ClockPort, LambdaFunctionName, PlatformPorts } from '@atl/shared';
import type { AslDefinition, FaultSpec } from '@atl/workflows';
import { createDocumentClient } from '../aws/deps.js';
import { createAgentHandler } from '../functions/agent/handler.js';
import { createApiHandler } from '../functions/api/handler.js';
import { createCertsHandler } from '../functions/certs/handler.js';
import { createChecksHandler } from '../functions/checks/handler.js';
import { createCopyArtifactsHandler } from '../functions/copy-artifacts/handler.js';
import { createCustomResourcesHandler } from '../functions/custom-resources/handler.js';
import { createLifecycleHandler } from '../functions/lifecycle/handler.js';
import { createPricingActions, createPricingHandler } from '../functions/pricing/handler.js';
import { fixturePriceListSource } from '../services/pricing/fixture.js';
import { createPublicHandler } from '../functions/public/handler.js';
import { createReaperHandler } from '../functions/reaper/handler.js';
import { createTaggerHandler } from '../functions/tagger/handler.js';
import { createTimerHandler } from '../functions/timer/handler.js';
import { createDevCheckEngine } from '../functions/checks/dev/engine-ports.js';
import type { EnginePortsProvider } from '../functions/checks/engine/ports.js';
import type { HttpEvent } from '../http/types.js';
import { DevReclaimCloud, installLifecycleDev, type LifecycleDev } from '../orchestrator-dev/index.js';
import type { ApiExtensions } from '../routes/index.js';
import type { DepsProvider, FunctionDeps } from '../runtime/deps.js';
import { loadPlatformEnv, type PlatformEnv } from '../runtime/env.js';
import { DevAuth } from './adapters/auth.js';
import { ScaledClock } from './adapters/clock.js';
import { DevEnvRegistry } from './adapters/envs.js';
import { MemoryEventPublisher } from './adapters/events.js';
import { InProcessInvoker, type InProcessFunction } from './adapters/invoker.js';
import { LocalL0Launcher } from './adapters/local-l0.js';
import { FsObjectStore } from './adapters/object-store.js';
import { SimulatedOrchestrator } from './adapters/orchestrator.js';
import { LocalRunCommand } from './adapters/run-command.js';
import { LocalProcessRunner, type RunnerCommandTable } from './adapters/runner.js';
import { InProcessScheduler } from './adapters/scheduler.js';
import { LocalEcdsaSigner } from './adapters/signer.js';
import { FakeTrailLookup } from './adapters/trail.js';
import { loadDevConfig, REPO_ROOT, type DevConfig } from './config.js';

export interface DevRuntimeOptions {
  /** Defaults to a ScaledClock with ATL_DEV_TIME_SCALE; tests pass a VirtualClock. */
  clock?: ClockPort;
  /** Override the ASL definitions (tests); defaults to platform/workflows/statemachines. */
  definitions?: Partial<Record<string, AslDefinition>>;
  faults?: FaultSpec[];
  /** Override the document client (tests without DynamoDB Local pass a stub). */
  db?: DynamoDBDocumentClient;
  /** Providers of the API routes that need AWS (03 WorkspaceProvider, MemberDirectory). */
  ext?: ApiExtensions;
  /**
   * How atl-checks answers the start workflow's Preflight / RunHealthGate: `engine` runs the dev check engine against the
   * local CloudAlbum (needs runner mode local-l0, the built check bundle and ATL_DEV_CHECK_RUNNER); `simulated` answers
   * PASS (no lab instance exists in the noop / dry-run runner modes). Default: `engine` in local-l0 mode, else `simulated`.
   */
  gates?: 'engine' | 'simulated';
  /** Install the lifecycle dev clouds (default true). */
  lifecycle?: boolean;
  /** Table names (default `cfg.tables`, else atl-main / cloudalbum-lab-locks); smoke:platform uses per-run tables in DynamoDB Local. */
  tables?: { main: string; locks: string };
}

export interface FunctionTableOptions {
  /** Engine ports of atl-checks (dev: createDevCheckEngine); default = production ports (they refuse to run in dev mode). */
  checksEngine?: EnginePortsProvider;
  ext?: ApiExtensions;
}

/**
 * Health-gate facts a local dev host cannot provide (local-l0 runner mode): the lab “instance” is a CloudAlbum api process
 * on the developer's machine — no systemd units for worker / nginx, no separate data volume — and the dev runner deploys no
 * AWS module of the start profile (e.g. iam=role needs IMDS + STS), so those modules stay `off`. The gate still runs all
 * its checks through ATL-RunCheck against the local L0; only these gaps are waived, never an `error` / `degraded` module or
 * a missing platform.env / probe secret. The waived items are listed in `report.devWaived`.
 */
export function devHealthGateWaiver(result: unknown): unknown {
  const r = result as { status?: string; report?: Record<string, { ok?: boolean; observed?: Record<string, unknown>; diffs?: { module: string; status?: string | null; driver?: string | null }[] }>; message?: string };
  if (!r || r.status !== 'FAIL' || !r.report) return result;
  const waived: string[] = [];
  for (const [gate, g] of Object.entries(r.report)) {
    if (g.ok) continue;
    const o = g.observed ?? {};
    if (gate === 'base.ready') {
      const svc = (o.services ?? {}) as Record<string, string>;
      const hostGapsOnly = svc.api === 'active' && o.platformEnvPresent === true && o.probeTokenPresent === true && ['worker', 'nginx'].every((k) => svc[k] === 'active' || svc[k] === 'unknown');
      if (!hostGapsOnly) return result;
      waived.push(`base.ready: worker=${svc.worker}, nginx=${svc.nginx}, dataVolumeMounted=${String(o.dataVolumeMounted)} (dev host)`);
    } else if (gate === 'caps.profile') {
      const diffs = g.diffs ?? [];
      if (!diffs.length || !diffs.every((d) => d.status === 'off')) return result;
      waived.push(...diffs.map((d) => `caps.profile: ${d.module} not deployed by the dev runner (driver ${d.driver ?? 'none'}, off)`));
    } else return result;
  }
  return { ...r, status: 'PASS', report: { ...r.report, devWaived: waived }, warnings: [...((r as { warnings?: string[] }).warnings ?? []), ...waived.map((w) => `dev waiver: ${w}`)] };
}

/** EventBridge rule on `atl-events` with atl-checks as target (platform/infra/src/45-events.yaml `ChecksEventsRule`). */
export const CHECKS_BUS_EVENTS: ReadonlySet<string> = new Set(['session.state_changed', 'reclaim.pass_completed']);

/** Builds the twelve function handlers from one deps provider (dev and tests). */
export function createFunctionTable(getDeps: DepsProvider, opts: FunctionTableOptions = {}): Record<LambdaFunctionName, InProcessFunction> {
  const api = createApiHandler(getDeps, opts.ext);
  const pub = createPublicHandler(getDeps);
  const agent = createAgentHandler(getDeps, opts.ext);
  return {
    'atl-api': (e) => api(e as HttpEvent),
    'atl-public': (e) => pub(e as HttpEvent),
    'atl-agent': (e) => agent(e as HttpEvent),
    'atl-checks': createChecksHandler(getDeps, undefined, opts.checksEngine),
    'atl-lifecycle': createLifecycleHandler(getDeps),
    'atl-timer': createTimerHandler(getDeps),
    'atl-reaper': createReaperHandler(getDeps),
    'atl-certs': createCertsHandler(getDeps),
    // dev Price List fixture: placeholder unit prices, quotes say pricing=fixture (never presented as AWS prices)
    'atl-pricing': createPricingHandler(getDeps, createPricingActions({ source: () => fixturePriceListSource() })),
    'atl-custom-resources': createCustomResourcesHandler(getDeps),
    'atl-copy-artifacts': createCopyArtifactsHandler(getDeps),
    'atl-tagger': createTaggerHandler(getDeps),
  };
}

export function devDocumentClient(cfg: Pick<DevConfig, 'ddbEndpoint' | 'region'>): DynamoDBDocumentClient {
  return createDocumentClient(
    new DynamoDBClient({ region: cfg.region, endpoint: cfg.ddbEndpoint, credentials: { accessKeyId: 'dev', secretAccessKey: 'dev' } }),
  );
}

export type DevRuntime = Awaited<ReturnType<typeof createDevRuntime>>;

export async function createDevRuntime(cfg: DevConfig = loadDevConfig(), opts: DevRuntimeOptions = {}) {
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  const env: PlatformEnv = {
    ...loadPlatformEnv({ AWS_REGION: cfg.region, ATL_ACCOUNT_ID: cfg.accountId, ATL_DEV_MODE: '1' }),
    signingKeyId: cfg.signingKeyId,
    ...((opts.tables ?? cfg.tables) ? { tableName: (opts.tables ?? cfg.tables)!.main, locksTableName: (opts.tables ?? cfg.tables)!.locks } : {}),
  };
  const clock = opts.clock ?? new ScaledClock(cfg.timeScale);
  const invoker = new InProcessInvoker();
  const objects = new FsObjectStore(path.join(cfg.dataDir, 'buckets'));
  const envs = new DevEnvRegistry(path.join(cfg.dataDir, 'envs'));
  const l0 = new LocalL0Launcher(REPO_ROOT);
  const commandsFile = process.env.ATL_DEV_RUNNER_COMMANDS;
  // the in-memory AWS “account” of the dev reclaimer: the dev runner registers what it creates (local L0 = lab instance)
  const reclaim = new DevReclaimCloud();
  const runner = new LocalProcessRunner({
    clock,
    mode: cfg.runnerMode,
    noopSeconds: cfg.runnerNoopSeconds,
    repoRoot: REPO_ROOT,
    dataDir: cfg.dataDir,
    objects,
    dataBucket: env.buckets.data,
    envs,
    l0,
    account: reclaim,
    region: env.region,
    platformOrigin: `https://127.0.0.1:${cfg.port}`,
    ...(commandsFile ? { commands: JSON.parse(fs.readFileSync(commandsFile, 'utf8')) as RunnerCommandTable } : {}),
  });
  // the reclaimer deleting the lab instance of an environment stops its local CloudAlbum (02 §7: S3 stage of the env)
  reclaim.onDeleted((r) => {
    const m = /^i-dev-(e[0-9a-z]{7})-lab$/.exec(r.id);
    if (r.type !== 'AWS::EC2::Instance' || !m) return;
    const rec = envs.list().find((x) => x.envName === m[1]);
    if (rec) void l0.stop(rec.envId).then(() => envs.upsert(rec.envId, { baseUrl: null }));
  });
  const runCommand = new LocalRunCommand({ clock, envs, checkRunner: cfg.checkRunner, repoRoot: REPO_ROOT });
  const scheduler = new InProcessScheduler(clock, invoker);
  const signer = new LocalEcdsaSigner(path.join(cfg.dataDir, 'keys'));
  const trail = new FakeTrailLookup(clock, cfg.trailDelaySeconds);
  if (cfg.trailFile) trail.loadFile(cfg.trailFile);
  const events = new MemoryEventPublisher();
  const orchestrator = new SimulatedOrchestrator({
    clock,
    invoker,
    runner,
    region: env.region,
    accountId: env.accountId,
    ...(opts.definitions ? { definitions: opts.definitions } : {}),
    ...(opts.faults ? { faults: opts.faults } : {}),
  });
  const ports: PlatformPorts = {
    clock,
    orchestrator,
    runner,
    runCommand,
    scheduler,
    signer,
    trail,
    auth: new DevAuth(clock),
    invoker,
    events,
    objects,
  };
  const deps: FunctionDeps = { ports, db: opts.db ?? devDocumentClient(cfg), env };
  const getDeps: DepsProvider = async () => deps;
  const checksEngine = createDevCheckEngine({ dataDir: cfg.dataDir });
  const functions = createFunctionTable(getDeps, { checksEngine, ...(opts.ext ? { ext: opts.ext } : {}) });
  for (const [name, fn] of Object.entries(functions)) invoker.register(name as LambdaFunctionName, fn);
  const gates = opts.gates ?? (cfg.runnerMode === 'local-l0' ? 'engine' : 'simulated');
  const engineChecks = functions['atl-checks'];
  // simulated gates: no lab instance exists in the noop / dry-run runner modes
  const checks: InProcessFunction =
    gates === 'engine'
      ? async (payload) => {
          const r = await engineChecks(payload);
          return (payload as { action?: string } | null)?.action === 'RunHealthGate' ? devHealthGateWaiver(r) : r;
        }
      : async (payload) => {
          const action = (payload as { action?: string } | null)?.action;
          if (action === 'Preflight') return { result: 'PASS', items: [], warnings: ['dev: account preflight simulated (no lab instance in this runner mode)'], variant: null };
          if (action === 'RunHealthGate') return { status: 'PASS', report: { dev: true, simulated: true, gates: (payload as { gates?: string[] }).gates ?? [] } };
          return engineChecks(payload);
        };
  invoker.register('atl-checks', checks);
  const lifecycleDev: LifecycleDev | null =
    opts.lifecycle === false ? null : installLifecycleDev({ deps, envs, runner, functions: { ...functions, 'atl-checks': checks }, invoker, orchestrator }, { reclaim });
  // atl-events rule (04 §12.3 consumer): deliver like EventBridge does (async, `detail-type` / `detail`)
  events.onEvent((e) => {
    if (!CHECKS_BUS_EVENTS.has(e.detailType)) return;
    void invoker.invokeAsync('atl-checks', { version: '0', source: e.source, 'detail-type': e.detailType, account: env.accountId, region: env.region, detail: e.detail });
  });
  return {
    cfg,
    env,
    deps,
    functions,
    clock,
    invoker,
    objects,
    envs,
    runner,
    runCommand,
    scheduler,
    signer,
    trail,
    events,
    orchestrator,
    reclaim,
    lifecycleDev,
    l0,
    checksEngine,
    /** atl-checks as registered (engine, plus the dev health-gate waiver or the simulated gates) */
    checks,
    async close() {
      lifecycleDev?.dispose();
      await scheduler.setSweeperEnabled(false);
      await l0.stopAll();
    },
  };
}
