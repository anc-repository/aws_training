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
import { createPricingHandler } from '../functions/pricing/handler.js';
import { createPublicHandler } from '../functions/public/handler.js';
import { createReaperHandler } from '../functions/reaper/handler.js';
import { createTaggerHandler } from '../functions/tagger/handler.js';
import { createTimerHandler } from '../functions/timer/handler.js';
import type { HttpEvent } from '../http/types.js';
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
}

/** Builds the twelve function handlers from one deps provider (dev and tests). */
export function createFunctionTable(getDeps: DepsProvider): Record<LambdaFunctionName, InProcessFunction> {
  const api = createApiHandler(getDeps);
  const pub = createPublicHandler(getDeps);
  const agent = createAgentHandler(getDeps);
  return {
    'atl-api': (e) => api(e as HttpEvent),
    'atl-public': (e) => pub(e as HttpEvent),
    'atl-agent': (e) => agent(e as HttpEvent),
    'atl-checks': createChecksHandler(getDeps),
    'atl-lifecycle': createLifecycleHandler(getDeps),
    'atl-timer': createTimerHandler(getDeps),
    'atl-reaper': createReaperHandler(getDeps),
    'atl-certs': createCertsHandler(getDeps),
    'atl-pricing': createPricingHandler(getDeps),
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
  };
  const clock = opts.clock ?? new ScaledClock(cfg.timeScale);
  const invoker = new InProcessInvoker();
  const objects = new FsObjectStore(path.join(cfg.dataDir, 'buckets'));
  const envs = new DevEnvRegistry(path.join(cfg.dataDir, 'envs'));
  const l0 = new LocalL0Launcher(REPO_ROOT);
  const commandsFile = process.env.ATL_DEV_RUNNER_COMMANDS;
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
    ...(commandsFile ? { commands: JSON.parse(fs.readFileSync(commandsFile, 'utf8')) as RunnerCommandTable } : {}),
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
  const functions = createFunctionTable(getDeps);
  for (const [name, fn] of Object.entries(functions)) invoker.register(name as LambdaFunctionName, fn);
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
    async close() {
      await scheduler.setSweeperEnabled(false);
      await l0.stopAll();
    },
  };
}
