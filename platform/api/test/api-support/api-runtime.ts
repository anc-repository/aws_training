/**
 * Test runtime for the API routes: real repositories and route handlers over either the in-memory document client or
 * DynamoDB Local, with deterministic fakes for the ports (virtual clock, dev tokens, in-process invoker, recording
 * orchestrator, in-memory object store and bus). `atl-lifecycle` is the dev fallback of `dev-server.ts`;
 * `atl-checks`, `atl-certs`, `atl-reaper` record their payloads; `atl-pricing` is not implemented (quotes degrade).
 */
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { VirtualClock } from '@atl/workflows';
import {
  ATL_MAIN_TABLE,
  Keys,
  PortError,
  WebKeys,
  type ExecutionDescription,
  type LambdaFunctionName,
  type ObjectStorePort,
  type OrchestratorPort,
  type PlatformPorts,
  type StartExecutionRequest,
  type StateMachineName,
} from '@atl/shared';
import { DevAuth, devToken } from '../../src/dev/adapters/auth.js';
import { MemoryEventPublisher } from '../../src/dev/adapters/events.js';
import { InProcessInvoker } from '../../src/dev/adapters/invoker.js';
import { devPlatformConfig } from '../../src/dev/create-tables.js';
import { DEV_LIFECYCLE_ACTIONS } from '../../src/dev-server.js';
import type { HttpEvent, HttpResult } from '../../src/http/types.js';
import { createRepositories, type Repositories } from '../../src/repositories/index.js';
import { createAgentHttpHandler, createApiHttpHandler, createPublicHttpHandler, type ApiExtensions } from '../../src/routes/index.js';
import type { FunctionDeps } from '../../src/runtime/deps.js';
import { loadPlatformEnv } from '../../src/runtime/env.js';
import { clearContentCache } from '../../src/services/catalog/store.js';
import { memoryDb } from './memory-ddb.js';
import { CATALOG_VERSION, fixtureIndex, fixtureLab, fixtureQuiz } from './fixtures.js';

export const T0 = Date.UTC(2026, 9, 14, 1, 0, 0);
export const ACCOUNT = '111122223333';

export class MemoryObjectStore implements ObjectStorePort {
  readonly objects = new Map<string, Uint8Array>();
  async put(bucket: string, key: string, body: Uint8Array | string): Promise<void> {
    this.objects.set(`${bucket}/${key}`, typeof body === 'string' ? new TextEncoder().encode(body) : body);
  }
  async get(bucket: string, key: string): Promise<Uint8Array | null> {
    return this.objects.get(`${bucket}/${key}`) ?? null;
  }
  async delete(bucket: string, key: string): Promise<void> {
    this.objects.delete(`${bucket}/${key}`);
  }
  async list(bucket: string, prefix: string): Promise<string[]> {
    return [...this.objects.keys()].filter((k) => k.startsWith(`${bucket}/${prefix}`)).map((k) => k.slice(bucket.length + 1));
  }
  async presign(bucket: string, key: string, opts: { method: 'GET' | 'PUT'; expiresInSeconds: number }): Promise<string> {
    return `https://${bucket}.s3.test/${key}?method=${opts.method}&expires=${opts.expiresInSeconds}`;
  }
}

/** Step Functions semantics that matter to the API: deterministic names, ExecutionAlreadyExists (02 §2.7). */
export class RecordingOrchestrator implements OrchestratorPort {
  readonly executions = new Map<string, ExecutionDescription>();
  executionArn(sm: StateMachineName, name: string): string {
    return `arn:aws:states:ap-northeast-1:${ACCOUNT}:execution:${sm}:${name}`;
  }
  async startExecution(req: StartExecutionRequest) {
    const arn = this.executionArn(req.stateMachine, req.name);
    const cur = this.executions.get(arn);
    if (cur) {
      if (cur.status === 'RUNNING' && JSON.stringify(cur.input) === JSON.stringify(req.input)) return { executionArn: arn, startDate: cur.startDate };
      throw new PortError('ExecutionAlreadyExists', `execution already exists: ${arn}`);
    }
    const startDate = new Date().toISOString();
    this.executions.set(arn, { executionArn: arn, stateMachine: req.stateMachine, name: req.name, status: 'RUNNING', input: req.input, startDate });
    return { executionArn: arn, startDate };
  }
  async describeExecution(arn: string) {
    const e = this.executions.get(arn);
    if (!e) throw new PortError('ExecutionDoesNotExist', arn);
    return e;
  }
  async stopExecution(arn: string) {
    const e = this.executions.get(arn);
    if (e) e.status = 'ABORTED';
  }
  finish(arn: string, status: ExecutionDescription['status'] = 'SUCCEEDED') {
    const e = this.executions.get(arn);
    if (e) e.status = status;
  }
  started(sm: StateMachineName): ExecutionDescription[] {
    return [...this.executions.values()].filter((e) => e.stateMachine === sm);
  }
}

function notImplemented(what: string): never {
  throw new PortError('NotImplemented', `${what} (test runtime)`);
}

export interface ApiTestRuntime {
  deps: FunctionDeps;
  repos: Repositories;
  clock: VirtualClock;
  invoker: InProcessInvoker;
  orchestrator: RecordingOrchestrator;
  objects: MemoryObjectStore;
  bus: MemoryEventPublisher;
  /** Payloads sent to atl-checks / atl-certs / atl-reaper. */
  calls: { fn: LambdaFunctionName; payload: Record<string, unknown> }[];
  api(e: HttpEvent): Promise<HttpResult>;
  agent(e: HttpEvent): Promise<HttpResult>;
  pub(e: HttpEvent): Promise<HttpResult>;
  /** Let async invocations run. */
  flush(): Promise<void>;
}

export async function createApiTestRuntime(opts: { db?: DynamoDBDocumentClient; tableName?: string; ext?: ApiExtensions; seed?: boolean } = {}): Promise<ApiTestRuntime> {
  clearContentCache();
  const clock = new VirtualClock(T0);
  const invoker = new InProcessInvoker();
  const orchestrator = new RecordingOrchestrator();
  const objects = new MemoryObjectStore();
  const bus = new MemoryEventPublisher();
  const env = { ...loadPlatformEnv({ ATL_ACCOUNT_ID: ACCOUNT, AWS_REGION: 'ap-northeast-1' }), tableName: opts.tableName ?? ATL_MAIN_TABLE };
  const ports = {
    clock,
    orchestrator,
    runner: { startBuild: () => notImplemented('runner'), getBuild: () => notImplemented('runner'), stopBuild: () => notImplemented('runner') },
    runCommand: { sendCommand: () => notImplemented('runCommand'), getInvocation: () => notImplemented('runCommand') },
    scheduler: { createOneTime: () => notImplemented('scheduler'), delete: () => notImplemented('scheduler'), get: () => notImplemented('scheduler'), setSweeperEnabled: () => notImplemented('scheduler') },
    signer: { sign: () => notImplemented('signer'), getPublicKey: () => notImplemented('signer') },
    trail: { lookupEvents: () => notImplemented('trail') },
    auth: new DevAuth(clock),
    invoker,
    events: bus,
    objects,
  } as unknown as PlatformPorts;
  const deps: FunctionDeps = { ports, db: opts.db ?? memoryDb().client, env };
  const getDeps = async () => deps;
  const calls: ApiTestRuntime['calls'] = [];
  invoker.register('atl-lifecycle', async (p) => {
    const action = String((p as { action?: string }).action);
    const h = DEV_LIFECYCLE_ACTIONS[action];
    if (!h) throw Object.assign(new Error(`atl-lifecycle: action ${action} is not implemented yet`), { name: 'Atl.NotImplemented' });
    return h(p as Record<string, unknown>, deps);
  });
  invoker.register('atl-pricing', async () => notImplemented('atl-pricing'));
  for (const fn of ['atl-checks', 'atl-certs', 'atl-reaper'] as const) {
    invoker.register(fn, async (p) => {
      const payload = p as Record<string, unknown>;
      calls.push({ fn, payload });
      if (payload.action === 'IssueCertificate') return { certId: 'ATL-7K2M-9Q4X-1ABZ-C3DE', jws: 'eyJ.test.sig', payload: { v: 1, kind: payload.scope } };
      if (payload.action === 'RevokeCertificate') return { certId: payload.certId, status: 'revoked', reason: payload.reason };
      return null;
    });
  }
  const api = createApiHttpHandler(getDeps, opts.ext ?? {});
  const agent = createAgentHttpHandler(getDeps, opts.ext ?? {});
  const pub = createPublicHttpHandler(getDeps, opts.ext ?? {});
  const repos = createRepositories(deps.db, env.tableName);
  const rt: ApiTestRuntime = {
    deps,
    repos,
    clock,
    invoker,
    orchestrator,
    objects,
    bus,
    calls,
    api,
    agent,
    pub,
    flush: () => new Promise((r) => setImmediate(r)),
  };
  if (opts.seed !== false) await seedFixtures(rt);
  return rt;
}

export async function seedFixtures(rt: ApiTestRuntime): Promise<void> {
  const nowIso = new Date(rt.clock.nowMs()).toISOString();
  await rt.repos.table.put({ ...devPlatformConfig(nowIso, 'ap-northeast-1', ACCOUNT, 8787), platformUrl: 'https://d1234.cloudfront.net', agentApiEndpoint: 'https://abc123.execute-api.ap-northeast-1.amazonaws.com', installLimits: { maxSessionMinutes: 360, maxKeepHours: 24, extension: { minutes: 30, maxCount: 2 } } });
  const web = rt.deps.env.buckets.web;
  const prefix = WebKeys.content(CATALOG_VERSION);
  await rt.objects.put(web, `${prefix}labs/svc-queue.json`, JSON.stringify(fixtureLab()));
  await rt.objects.put(web, `${prefix}catalog/index.json`, JSON.stringify(fixtureIndex()));
  await rt.objects.put(rt.deps.env.buckets.artifacts, `releases/${CATALOG_VERSION}/private/quiz/svc-queue.json`, JSON.stringify(fixtureQuiz()));
  await rt.repos.table.put({ ...Keys.catalogRelease(CATALOG_VERSION), type: 'CatalogRelease', ver: 1, createdAt: nowIso, updatedAt: nowIso, catalogVersion: CATALOG_VERSION, contentDigest: 'sha256:test' });
  await rt.repos.table.put({ ...Keys.catalogCurrent(), type: 'CatalogRelease', ver: 1, createdAt: nowIso, updatedAt: nowIso, catalogVersion: CATALOG_VERSION });
}

// ---------------------------------------------------------------------------------------------------------------
// Request helpers

let reqCounter = 0;

export interface Req {
  token?: string;
  caller?: string;
  body?: unknown;
  key?: string;
  headers?: Record<string, string>;
  query?: Record<string, string>;
}

export function ev(method: string, path: string, r: Req = {}): HttpEvent {
  const url = new URL(path, 'http://x');
  const query = { ...Object.fromEntries(url.searchParams.entries()), ...(r.query ?? {}) };
  const headers: Record<string, string> = { ...(r.headers ?? {}) };
  if (r.token) headers.authorization = `Bearer ${r.token}`;
  if (r.key) headers['idempotency-key'] = r.key;
  else if (['POST', 'PUT'].includes(method) && !('idempotency-key' in headers)) headers['idempotency-key'] = `test-key-${++reqCounter}-${Math.random().toString(36).slice(2)}`;
  return {
    version: '2.0',
    rawPath: url.pathname,
    headers,
    queryStringParameters: query,
    ...(r.body === undefined ? {} : { body: JSON.stringify(r.body) }),
    requestContext: {
      requestId: `req-${++reqCounter}`,
      http: { method, sourceIp: '198.51.100.7', userAgent: 'vitest' },
      ...(r.caller ? { authorizer: { iam: { userArn: r.caller } } } : {}),
    },
  };
}

export const LEARNER = devToken('learner', 'u-learner');
export const ASSISTANT = devToken('assistant', 'u-ta');
export const OBSERVER = devToken('observer', 'u-obs');
export const wsCaller = (sid: string) => `arn:aws:sts::${ACCOUNT}:assumed-role/ATLLearnerRole/atl-${sid}-ws`;
export const provCaller = (sid: string, op = 'profile-apply') => `arn:aws:sts::${ACCOUNT}:assumed-role/ATLProvisionerRole/atl-${sid}-prov-${op}`;

export function body<T = Record<string, unknown>>(r: HttpResult): T {
  return (r.body ? JSON.parse(r.body) : {}) as T;
}
