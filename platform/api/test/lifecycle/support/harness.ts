/**
 * Lifecycle test harness: the real ASL files in the in-process simulator, the twelve function handlers in an
 * in-process invoker, the in-process scheduler on a VirtualClock, the scripted runner, the dev clouds of
 * `src/orchestrator-dev`, an in-memory `atl-main` (or DynamoDB Local with ATL_IT=1) and an in-memory object store.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { CreateTableCommand } from '@aws-sdk/client-dynamodb';
import { GetCommand, PutCommand, QueryCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  ATL_MAIN_SPEC,
  Keys,
  LAB_LOCKS_SPEC,
  type AuthPort,
  type LambdaFunctionName,
  type PlatformPorts,
  type SignerPort,
} from '@atl/shared';
import { VirtualClock, loadAllStateMachines, type AslDefinition, type FaultSpec } from '@atl/workflows';
import { createDocumentClient } from '../../../src/aws/deps.js';
import { InProcessInvoker } from '../../../src/dev/adapters/invoker.js';
import { MemoryEventPublisher } from '../../../src/dev/adapters/events.js';
import { SimulatedOrchestrator } from '../../../src/dev/adapters/orchestrator.js';
import { InProcessScheduler } from '../../../src/dev/adapters/scheduler.js';
import { FakeTrailLookup } from '../../../src/dev/adapters/trail.js';
import { createFunctionTable } from '../../../src/dev/runtime.js';
import type { CardSnapshot, SessionRecord } from '../../../src/functions/lifecycle/store/model.js';
import type { FunctionDeps } from '../../../src/runtime/deps.js';
import { loadPlatformEnv, type PlatformEnv } from '../../../src/runtime/env.js';
import { installLifecycleDev, type LifecycleDev } from '../../../src/orchestrator-dev/index.js';
import { MemoryDocumentClient } from './memory-ddb.js';
import { MemoryObjectStore } from './memory-objects.js';
import { MemoryEnvRegistry, ScriptedRunner, type ScriptedRunnerOptions } from './scripted-runner.js';
import { FakeRunCommand } from './fake-run-command.js';

export const T0 = Date.UTC(2026, 9, 14, 1, 0, 0);
export const SUB = 'learner-1';

export function cardFixture(over: Partial<CardSnapshot> = {}): CardSnapshot {
  return {
    labId: 'svc-queue',
    labKind: 'service',
    labVersion: '1.0.0',
    catalogVersion: '2026.10.0',
    variant: 'default',
    startProfile: 'atl/svc-queue/default',
    startProfileDigest: 'sha256:abc',
    timeLimitMinutes: 90,
    extensions: { maxCount: 2, minutesEach: 30 },
    retain: { allowed: true, maxHours: 24 },
    provision: { class: 'A', budgetMinutes: null, cleanupBudgetMinutes: null },
    workstation: { required: false, sshFromWorkstation: false, sshUser: null },
    regions: { extra: [], alsoUses: [] },
    extraStacks: [],
    platformActions: [{ id: 'iam-revoke-sessions', op: 'enable', module: 'iam', title: 'revoke instance sessions', interruptsManagementChannel: true }],
    targetModules: [{ id: 'queue', from: 'memory', to: 'sqs' }],
    expectedWarnings: [],
    keepablePrerequisites: [],
    requiredLearnerInputs: [],
    preflightVariants: [],
    testUsersSeeded: false,
    costTier: 'low',
    ...over,
  };
}

export interface HarnessOptions {
  faults?: FaultSpec[];
  definitions?: Partial<Record<string, AslDefinition>>;
  runner?: Partial<Pick<ScriptedRunnerOptions, 'seconds' | 'profileStacks'>>;
  trailDelaySeconds?: number;
  config?: Record<string, unknown>;
  /** use DynamoDB Local (ATL_IT=1) instead of the in-memory table */
  dynamodbLocal?: boolean;
}

export type Harness = Awaited<ReturnType<typeof createHarness>>;

async function localDdb(env: PlatformEnv): Promise<DynamoDBDocumentClient> {
  const raw = new DynamoDBClient({ region: env.region, endpoint: process.env.ATL_DEV_DDB_ENDPOINT ?? 'http://127.0.0.1:58000', credentials: { accessKeyId: 'dev', secretAccessKey: 'dev' } });
  for (const spec of [
    { ...ATL_MAIN_SPEC, TableName: env.tableName },
    { ...LAB_LOCKS_SPEC, TableName: env.locksTableName },
  ]) {
    const { ttlAttribute: _ttl, ...input } = spec;
    await raw.send(new CreateTableCommand(input as never));
  }
  return createDocumentClient(raw);
}

export async function createHarness(opts: HarnessOptions = {}) {
  const clock = new VirtualClock(T0);
  const suffix = Math.random().toString(36).slice(2, 8);
  const env: PlatformEnv = {
    ...loadPlatformEnv({ AWS_REGION: 'ap-northeast-1', ATL_ACCOUNT_ID: '000000000000', ATL_DEV_MODE: '1' }),
    ...(opts.dynamodbLocal ? { tableName: `atl-main-${suffix}`, locksTableName: `cloudalbum-lab-locks-${suffix}` } : {}),
  };
  const memory = new MemoryDocumentClient();
  const db = opts.dynamodbLocal ? await localDdb(env) : (memory as unknown as DynamoDBDocumentClient);
  const objects = new MemoryObjectStore();
  const invoker = new InProcessInvoker();
  const scheduler = new InProcessScheduler(clock, invoker);
  const trail = new FakeTrailLookup(clock, opts.trailDelaySeconds ?? 0);
  const events = new MemoryEventPublisher();
  const envs = new MemoryEnvRegistry();
  const runCommand = new FakeRunCommand();
  // the reclaim "account" is created by installLifecycleDev; the runner needs it, so build the runner lazily
  // eslint-disable-next-line prefer-const -- assigned below, after the closures that read it
  let runner!: ScriptedRunner;
  const lazyRunner = {
    startBuild: (r: Parameters<ScriptedRunner['startBuild']>[0]) => runner.startBuild(r),
    getBuild: (id: string) => runner.getBuild(id),
    stopBuild: (id: string) => runner.stopBuild(id),
    list: () => runner.list(),
  };
  const definitions = { ...loadAllStateMachines(), ...(opts.definitions ?? {}) };
  const orchestrator = new SimulatedOrchestrator({ clock, invoker, runner: lazyRunner, region: env.region, accountId: env.accountId, definitions, ...(opts.faults ? { faults: opts.faults } : {}) });
  const ports: PlatformPorts = {
    clock,
    orchestrator,
    runner: lazyRunner,
    runCommand,
    scheduler,
    signer: {} as SignerPort,
    trail,
    auth: {} as AuthPort,
    invoker,
    events,
    objects,
  };
  const deps: FunctionDeps = { ports, db, env };
  const functions = createFunctionTable(async () => deps);
  for (const [name, fn] of Object.entries(functions)) invoker.register(name as LambdaFunctionName, fn);
  const dev: LifecycleDev = installLifecycleDev({ deps, envs, runner: lazyRunner, functions, invoker, orchestrator });
  // deterministic stand-in for atl-checks (Preflight / RunHealthGate / FinalizeAttempt are 04's; their contract is
  // documented in the platform-lifecycle notes)
  const checks = {
    preflight: { result: 'PASS', items: [], warnings: [], variant: null } as Record<string, unknown>,
    health: [] as Record<string, unknown>[],
    finalizeFails: false,
    calls: [] as Record<string, unknown>[],
  };
  invoker.register('atl-checks', async (payload) => {
    const p = payload as Record<string, unknown>;
    checks.calls.push(p);
    if (p.action === 'Preflight') return checks.preflight;
    if (p.action === 'RunHealthGate') return checks.health.shift() ?? { status: 'PASS', report: { gates: p.gates } };
    if (p.action === 'FinalizeAttempt') {
      if (checks.finalizeFails) throw Object.assign(new Error('finalize failed (test)'), { name: 'Atl.FinalizeFailed' });
      return { finalized: true };
    }
    throw Object.assign(new Error(`atl-checks ${String(p.action)}`), { name: 'Atl.NotImplemented' });
  });
  runner = new ScriptedRunner({ clock, objects, dataBucket: env.buckets.data, region: env.region, envs, account: dev.reclaim, ...(opts.runner ?? {}) });

  // platform configuration and the quotes the learner confirmed
  const now = new Date(T0).toISOString();
  await deps.db.send(
    new PutCommand({
      TableName: env.tableName,
      Item: {
        ...Keys.platformConfig(),
        type: 'PlatformConfig',
        ver: 1,
        createdAt: now,
        updatedAt: now,
        version: '0.1.0-test',
        region: env.region,
        drRegion: 'ap-northeast-3',
        platformUrl: 'https://d111.cloudfront.net',
        agentApiEndpoint: 'https://abc123.execute-api.ap-northeast-1.amazonaws.com',
        workloadBoundaryArn: 'arn:aws:iam::000000000000:policy/ATLWorkloadBoundary',
        mode: 'NORMAL',
        maintenance: false,
        ...(opts.config ?? {}),
      },
    }),
  );

  const h = {
    clock,
    env,
    deps,
    memory,
    objects,
    invoker,
    scheduler,
    trail,
    events,
    envs,
    runCommand,
    orchestrator,
    sim: orchestrator.sim,
    dev,
    checks,
    get runner() {
      return runner;
    },
    lifecycle: <T = Record<string, unknown>>(payload: Record<string, unknown>) => invoker.invoke<T>('atl-lifecycle', payload),
    timer: <T = Record<string, unknown>>(payload: Record<string, unknown>) => invoker.invoke<T>('atl-timer', payload),
    reaper: <T = Record<string, unknown>>(payload: Record<string, unknown>) => invoker.invoke<T>('atl-reaper', payload),
    async putQuote(quoteId: string, over: Record<string, unknown> = {}) {
      const at = new Date(clock.nowMs()).toISOString();
      await deps.db.send(
        new PutCommand({
          TableName: env.tableName,
          Item: {
            ...Keys.costQuote(SUB, quoteId),
            type: 'CostQuote',
            ver: 1,
            createdAt: at,
            updatedAt: at,
            quoteId,
            purpose: 'START',
            labId: 'svc-queue',
            labVersion: '1.0.0',
            variant: 'default',
            expiresAt: new Date(clock.nowMs() + 15 * 60_000).toISOString(),
            ...over,
          },
        }),
      );
    },
    async session(sid: string): Promise<SessionRecord> {
      const r = await deps.db.send(new GetCommand({ TableName: env.tableName, Key: Keys.labSession(sid), ConsistentRead: true }));
      return r.Item as SessionRecord;
    },
    async item(key: { PK: string; SK: string }): Promise<Record<string, unknown> | null> {
      const r = await deps.db.send(new GetCommand({ TableName: env.tableName, Key: key, ConsistentRead: true }));
      return (r.Item as Record<string, unknown> | undefined) ?? null;
    },
    async query(pk: string, skPrefix: string): Promise<Record<string, unknown>[]> {
      const r = await deps.db.send(
        new QueryCommand({
          TableName: env.tableName,
          KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :sk)',
          ExpressionAttributeNames: { '#pk': 'PK', '#sk': 'SK' },
          ExpressionAttributeValues: { ':pk': pk, ':sk': skPrefix },
        }),
      );
      return (r.Items as Record<string, unknown>[]) ?? [];
    },
    /** Start a session the way atl-api does (quote + CreateSession). */
    async start(over: Record<string, unknown> = {}, card: Partial<CardSnapshot> = {}): Promise<{ sid: string; startArn: string }> {
      const quoteId = `q-${Math.random().toString(36).slice(2, 10)}`;
      await h.putQuote(quoteId, (over.quote as Record<string, unknown>) ?? {});
      const r = await h.lifecycle<{ sessionId: string; executionArn: string }>({
        action: 'CreateSession',
        sub: SUB,
        labId: 'svc-queue',
        quoteId,
        costAcknowledged: true,
        card: cardFixture(card),
        actor: 'user',
        ...over,
      });
      return { sid: r.sessionId, startArn: r.executionArn };
    },
    async waitExecution(stateMachine: 'atl-session-start' | 'atl-session-end' | 'atl-reclaim' | 'atl-reclaim-rescan' | 'atl-module-op' | 'atl-platform-uninstall', name: string) {
      return orchestrator.sim.waitFor(orchestrator.executionArn(stateMachine, name));
    },
    /** Advance the virtual clock until `cond()` holds (or fail after `maxMs` of platform time). */
    async until(cond: () => Promise<boolean> | boolean, maxMs = 12 * 3_600_000, stepMs = 60_000): Promise<void> {
      const deadline = clock.nowMs() + maxMs;
      while (!(await cond())) {
        if (clock.nowMs() > deadline) throw new Error(`condition not reached within ${maxMs / 60_000} platform minutes`);
        await clock.sleep(stepMs);
      }
    },
    async close() {
      dev.dispose();
      await scheduler.setSweeperEnabled(false);
    },
  };
  return h;
}
