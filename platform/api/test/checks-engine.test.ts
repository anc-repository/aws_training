/**
 * The check engine end to end in ATL_DEV_MODE style: real check bundle executed through the dev LocalRunCommand against
 * a local CloudAlbum stand-in, the dev engine (fake AWS, dev HTTP), an in-memory atl-main. Covers every check type,
 * ownership (pending → found, not owned), header spoofing defence, drift (must-hold vs once), manual confirmations,
 * experiments, finalization with badge, idempotency, health gates and cleanup verification.
 */
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { envNameFromEnvId, type PlatformPorts } from '@atl/shared';
import { Keys } from '../src/data/keys.js';
import { DevEnvRegistry } from '../src/dev/adapters/envs.js';
import { LocalRunCommand } from '../src/dev/adapters/run-command.js';
import { LocalEcdsaSigner } from '../src/dev/adapters/signer.js';
import { createDevCheckEngine } from '../src/functions/checks/dev/engine-ports.js';
import { primeContentCache } from '../src/functions/checks/engine/facts.js';
import type { OwnershipLookupResult } from '../src/functions/checks/engine/ownership.js';
import { runChecks } from '../src/functions/checks/engine/run.js';
import { applyManualConfirmation, cleanupVerify, finalizeAttempt, healthGate, stepAction, submitAttempt } from '../src/functions/checks/flows.js';
import { createChecksHandler } from '../src/functions/checks/handler.js';
import type { CheckRunItem } from '../src/functions/checks/types.js';
import type { FunctionDeps } from '../src/runtime/deps.js';
import { loadPlatformEnv } from '../src/runtime/env.js';
import type { LabAttemptItem, LabProgressItem, StepResultItem } from '../src/services/progress/types.js';
import { CATALOG, LAB_ID, testCard } from './checks-support/card.js';
import { MemoryItemStore, MemoryObjects, RecordingEvents, RecordingScheduler, TableInvoker, TestClock } from './checks-support/memory.js';
import { NO_DB, REPO_ROOT, tmpDir } from './helpers.js';

const SID = 's4k7m2q9x1abc';
const SUB = 'u-1111';
const ENV_ID = '01jc9x3k9cq4m2x8n5b6c0d1e2';
const ENV_NAME = envNameFromEnvId(ENV_ID);
const DIST = 'E2QWRUHAPOMQZL';
const DIST_ARN = `arn:aws:cloudfront::000000000000:distribution/${DIST}`;

interface AppState {
  cdn: { driver: string; status: string };
  spoof: boolean;
  calls: { url: string; headers: http.IncomingHttpHeaders }[];
}
const app: AppState = { cdn: { driver: 'direct', status: 'off' }, spoof: false, calls: [] };
const usedTokens = new Set<string>();
let server: http.Server;
let baseUrl: string;
let dataDir: string;
let bundleOut: string;
let digest: string;
let store: MemoryItemStore;
let deps: FunctionDeps;
let engine: ReturnType<typeof createDevCheckEngine>;
let clock: TestClock;
let events: RecordingEvents;
let reaper: { next: OwnershipLookupResult };
let invoker: TableInvoker;

function startServer(): Promise<void> {
  let n = 0;
  server = http.createServer((req, res) => {
    app.calls.push({ url: req.url ?? '', headers: req.headers });
    const spoof = app.spoof ? { 'x-cache': 'Hit from cloudfront', 'x-amz-cf-id': 'fake-id==' } : {};
    if (req.url?.startsWith('/api/capabilities')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          app: { entry: { baseUrl } },
          modules: { cdn: { ...app.cdn, localHealth: 'ok' }, auth: { driver: 'local', status: 'degraded', localHealth: 'ok' }, iam: { driver: 'role', status: 'ok' } },
          validation: { errors: [], warnings: [{ rule: 'DEP-013', modules: ['auth'] }] },
        }),
      );
      return;
    }
    if (req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html' }).end('<html><script src="/assets/index-AbC123.js"></script></html>');
      return;
    }
    if (req.url?.startsWith('/assets/')) {
      res.writeHead(200, { 'content-type': 'text/javascript', 'x-cloudalbum-path': 'entry=nginx', ...spoof }).end();
      return;
    }
    if (req.url?.startsWith('/api/public/now')) {
      n++;
      res.writeHead(200, { 'content-type': 'application/json', 'x-cloudalbum-path': 'entry=nginx', ...spoof });
      res.end(JSON.stringify({ now: app.spoof ? 'same' : `t${n}` }));
      return;
    }
    if (req.url?.startsWith('/api/lab/probe/now')) {
      const tok = String(req.headers['x-atl-probe-token'] ?? '');
      if (!tok.startsWith('atlpt1.') || usedTokens.has(tok)) {
        res.writeHead(401).end();
        return;
      }
      usedTokens.add(tok);
      n++;
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'private, no-store' }).end(JSON.stringify({ now: `p${n}` }));
      return;
    }
    if (req.url?.startsWith('/api/health/live')) {
      res.writeHead(200, { 'content-type': 'application/json', 'x-cloudalbum-path': 'entry=nginx' }).end('{"ok":true}');
      return;
    }
    res.writeHead(404).end();
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r()));
}

/**
 * The CloudAlbum `probe-token` CLI (06 PM-13) does not exist in this test; this wrapper answers the `probe-token` checkId
 * like the bundle would (a correctly bound ATL-RESULT-V1 line) and delegates everything else to the dev LocalRunCommand.
 */
class TokenRunCommand {
  private n = 0;
  private readonly own = new Map<string, { stdout: string }>();
  constructor(private readonly inner: LocalRunCommand) {}
  async sendCommand(req: Parameters<LocalRunCommand['sendCommand']>[0]) {
    if (req.parameters.CheckId !== 'probe-token') return this.inner.sendCommand(req);
    const args = JSON.parse(Buffer.from(req.parameters.ArgsB64!, 'base64url').toString('utf8')) as { count?: number };
    const tokens = Array.from({ length: args.count ?? 1 }, () => `atlpt1.${++this.n}.${Math.random().toString(36).slice(2)}`);
    const line = { schema: 'atl.runcheck.result/v1', key: 'c1', checkId: 'probe-token', runToken: req.parameters.RunToken, sessionId: req.parameters.SessionId, bundle: { version: '1.0.0', digest: req.parameters.BundleDigest }, host: { instanceId: req.instanceIds[0], role: 'lab' }, status: 'ok', errorCode: null, observed: { tokens, expiresAt: null } };
    const commandId = `tok-${this.n}`;
    this.own.set(`${commandId}/${req.instanceIds[0]}`, { stdout: `ATL-RESULT-V1 ${Buffer.from(JSON.stringify(line)).toString('base64url')}
` });
    return { commandId };
  }
  async getInvocation(commandId: string, instanceId: string) {
    const o = this.own.get(`${commandId}/${instanceId}`);
    if (!o) return this.inner.getInvocation(commandId, instanceId);
    return { commandId, instanceId, status: 'Success' as const, responseCode: 0, stdout: o.stdout, stderr: '' };
  }
}

function seed(): void {
  store = new MemoryItemStore();
  const now = new Date(clock.nowMs());
  const readyAt = new Date(now.getTime() - 30 * 60_000).toISOString();
  store.seed({
    ...Keys.labSession(SID),
    type: 'LabSession',
    sid: SID,
    sub: SUB,
    labId: LAB_ID,
    labKind: 'service',
    variant: 'default',
    catalogVersion: CATALOG,
    envId: ENV_ID,
    state: 'RUNNING',
    stateEnteredAt: readyAt,
    createdAt: new Date(now.getTime() - 40 * 60_000).toISOString(),
    readyAt,
    deadlineAt: new Date(now.getTime() + 60 * 60_000).toISOString(),
    startProfile: `atl/${LAB_ID}/default`,
    startProfileDigest: 'sha256:x',
    targetModules: [{ id: 'cdn', from: null, to: 'cloudfront' }],
    cardFacts: { platformActions: [], sshFromWorkstation: false, sshUser: null },
    outageWindow: null,
  });
  store.seed({ ...Keys.environment(ENV_ID), type: 'Environment', envId: ENV_ID, envName: ENV_NAME, status: 'ACTIVE', ownerSessionId: SID, sessionChain: [SID], labChain: [LAB_ID], enabledModules: ['iam'], stacks: [`cloudalbum-${ENV_NAME}-ec2`], endpoints: { baseUrl: null } });
  store.seed({ ...Keys.platformConfig(), type: 'PlatformConfig', region: 'ap-northeast-1', installationId: '3f6c1e2a-0000-4000-8000-000000000000', platformUrl: 'https://d1.cloudfront.net', drRegion: null });
  store.seed({ ...Keys.labAttempt(SID), type: 'LabAttempt', sessionId: SID, sub: SUB, labId: LAB_ID, labKind: 'service', status: 'active', labVersion: '1.0.0', catalogVersion: CATALOG, contentDigest: 'sha256:test-content', variant: 'default', variables: { distributionId: DIST }, ownershipPending: [] });
}

beforeAll(async () => {
  await startServer();
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  dataDir = tmpDir('engine-');
  bundleOut = tmpDir('engine-bundle-');
  const { buildBundle } = (await import(pathToFileURL(path.join(REPO_ROOT, 'platform', 'checks', 'build.mjs')).href)) as { buildBundle: (o: { outDir: string; createdAt: string }) => Promise<{ bundleDigest: string }> };
  digest = (await buildBundle({ outDir: bundleOut, createdAt: '2026-10-14T00:00:00.000Z' })).bundleDigest;
  const envs = new DevEnvRegistry(path.join(dataDir, 'envs'));
  envs.upsert(ENV_ID, { envName: ENV_NAME, baseUrl, root: null });
  clock = new TestClock();
  events = new RecordingEvents();
  reaper = { next: { status: 'PENDING', retryAfterSeconds: 120, waitedSeconds: 0 } };
  invoker = new TableInvoker({
    'atl-reaper': async () => reaper.next,
    'atl-certs': async () => ({ revision: 1 }),
  });
  const ports = {
    clock,
    runCommand: new TokenRunCommand(new LocalRunCommand({ clock, envs, checkRunner: path.join(bundleOut, 'atl', 'bin', 'atl-check.mjs'), repoRoot: REPO_ROOT })),
    invoker,
    events,
    objects: new MemoryObjects(),
    scheduler: new RecordingScheduler(),
    signer: new LocalEcdsaSigner(path.join(dataDir, 'keys')),
  } as unknown as PlatformPorts;
  deps = { ports, db: NO_DB, env: { ...loadPlatformEnv({ ATL_DEV_MODE: '1', AWS_REGION: 'ap-northeast-1' }) } };
  engine = createDevCheckEngine({ dataDir, bundleDigest: digest, ipRanges: [] });
  engine.aws
    .on('cloudfront:GetDistribution', (req) => {
      if (req.params.Id === 'EGONE0000001') throw Object.assign(new Error('gone'), { name: 'NoSuchDistribution' });
      return { Distribution: { Id: DIST, ARN: DIST_ARN, Status: 'Deployed', DomainName: `${ENV_NAME}.dev.atl.test`, DistributionConfig: { Enabled: true, Aliases: { Items: [] }, Origins: { Items: [{ CustomHeaders: { Items: [{ HeaderName: 'X-Origin-Verify', HeaderValue: 'top-secret' }] } }] } } } };
    })
    .on('ec2:DescribeSecurityGroups', { SecurityGroups: [{ GroupName: 'lab', IpPermissions: [{ FromPort: 80, IpRanges: [{ CidrIp: '0.0.0.0/0' }] }] }] });
  primeContentCache(CATALOG, LAB_ID, testCard());
}, 60_000);

beforeEach(() => {
  seed();
  app.cdn = { driver: 'direct', status: 'off' };
  app.spoof = false;
  reaper.next = { status: 'PENDING', retryAfterSeconds: 120, waitedSeconds: 0 };
  clock.offset = 0;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  primeContentCache(CATALOG, LAB_ID, null);
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(bundleOut, { recursive: true, force: true });
});

async function step(stepId: string, extra: Record<string, unknown> = {}) {
  const out = await runChecks(deps, engine(deps) as never, store, { sessionId: SID, stepId, trigger: 'user', force: true, ...extra });
  const by = Object.fromEntries(out.run.results.map((r) => [r.checkId, r]));
  return { out, by, state: out.steps.get(stepId)?.state };
}

describe('check types against the local stand-in', () => {
  it('capability + platform http-header (public-ip, sample.assetPath): before-state checks pass', async () => {
    const { by, state } = await step('orient');
    expect(by['cdn-off']!.result).toBe('pass');
    expect(by['cdn-off']!.source).toBe('PROBE');
    expect(by['entry-direct']!.result, JSON.stringify(by['entry-direct']!.error)).toBe('pass');
    expect(by['entry-direct']!.source).toBe('LOCAL');
    expect(app.calls.some((c) => c.url === '/assets/index-AbC123.js')).toBe(true);
    expect(app.calls.find((c) => c.url === '/assets/index-AbC123.js')!.headers['x-atl-probe-nonce']).toBeDefined();
    expect(state).toBe('done');
    const run = (await store.get<CheckRunItem>(Keys.checkRun(SID, (await store.query<CheckRunItem>(Keys.labSession(SID).PK, { skPrefix: 'RUN#' }))[0]!.runId)))!;
    expect(run.status).toBe('done');
    expect(run.results[0]!.evidence?.schema).toBe('atl.evidence/v1');
    expect(events.types()).toContain('check_run.completed');
    expect(events.types()).toContain('step.state_changed');
  }, 60_000);

  it('aws-readonly with ownership: pending while CloudTrail has no record, then found; local check over ATL-RunCheck', async () => {
    app.cdn = { driver: 'cloudfront', status: 'ok' };
    const first = await step('enable-cdn');
    expect(first.by['cap-cdn']!.result).toBe('pass');
    expect(first.by['auth-healthy']!.result).toBe('pass');
    expect(first.by['auth-healthy']!.expectedWarningsHit).toEqual(['DEP-013']);
    expect(first.by['origin-ok']!.result).toBe('pass');
    expect(first.by['origin-ok']!.executor.ssm?.length).toBeGreaterThan(0);
    expect(first.by['dist-deployed']!.result).toBe('pending');
    expect(first.by['dist-deployed']!.error?.code).toBe('OWNERSHIP_PENDING');
    expect(first.state).toBe('verifying');
    expect(invoker.calls.filter((c) => c.fn === 'atl-reaper')).toHaveLength(1);
    // within the 2-minute rhythm no new lookup is requested
    await step('enable-cdn');
    expect(invoker.calls.filter((c) => c.fn === 'atl-reaper')).toHaveLength(1);
    // CloudTrail delivered: the learner's console session created it
    reaper.next = { status: 'FOUND', sessionId: SID, roleSessionName: `atl-${SID}-console`, eventId: 'ev1', eventName: 'CreateDistribution', eventTime: new Date(clock.nowMs() - 60_000).toISOString(), region: 'us-east-1' };
    clock.advance(3 * 60_000);
    const second = await step('enable-cdn');
    expect(second.by['dist-deployed']!.result).toBe('pass');
    expect(second.by['dist-deployed']!.ownership?.basis).toBe('lookup');
    expect(second.by['dist-deployed']!.provenance).toBe('this-session');
    expect(JSON.stringify(second.by['dist-deployed']!.evidence)).not.toContain('top-secret');
    expect(second.state).toBe('done');
  }, 60_000);

  it('ownership mismatch fails with the not-mine pitfall', async () => {
    app.cdn = { driver: 'cloudfront', status: 'ok' };
    reaper.next = { status: 'NOT_OWNED', actor: 'atl-sOTHER0000000-console', eventId: 'e' };
    const r = await step('enable-cdn', { checkIds: ['dist-deployed'] });
    expect(r.by['dist-deployed']!.result).toBe('fail');
    expect(r.by['dist-deployed']!.error?.code).toBe('OWNERSHIP_MISMATCH');
    expect(r.by['dist-deployed']!.pitfalls).toEqual(['not-mine']);
  }, 60_000);

  it('allowlist, expectError and dependsOn-free optional checks', async () => {
    const r = await step('extras', { checkIds: ['denied', 'gone'] });
    expect(r.by.denied!.result).toBe('error');
    expect(r.by.denied!.error?.code).toBe('NOT_ALLOWED');
    expect(r.by.gone!.result).toBe('pass');
  }, 60_000);

  it('header spoofing: CDN headers written by the origin are caught by the corroborations', async () => {
    app.spoof = true;
    reaper.next = { status: 'FOUND', sessionId: SID, roleSessionName: `atl-${SID}-console`, eventId: 'ev1', eventName: 'CreateDistribution', eventTime: new Date(clock.nowMs() - 60_000).toISOString(), region: 'us-east-1' };
    const r = await step('extras', { checkIds: ['edge-spoof'] });
    const e = r.by['edge-spoof']!;
    // the main assertions are satisfied by the forged headers, the corroborations are not
    expect(e.keyAssertions.every((a) => a.ok)).toBe(true);
    expect(e.result).toBe('fail');
    expect(e.error?.code).toBe('SPOOF_SUSPECTED');
    expect(e.corroboration.find((k) => k.id === 'edge-network')!.ok).toBe(false);
    expect(e.corroboration.find((k) => k.id === 'origin-clean')!.ok).toBe(false);
    expect(e.pitfalls).toEqual(['spoofed-headers']);
    expect(JSON.stringify(e.evidence)).not.toContain('fake-id==');
  }, 60_000);

  it('http-header from the lab instance, and platform probes of /api/lab/probe/* with one-time tokens', async () => {
    reaper.next = { status: 'FOUND', sessionId: SID, roleSessionName: `atl-${SID}-console`, eventId: 'ev1', eventName: 'CreateDistribution', eventTime: new Date(clock.nowMs() - 60_000).toISOString(), region: 'us-east-1' };
    const r = await step('extras', { checkIds: ['origin-lab', 'api-probe'] });
    expect(r.by['origin-lab']!.result, JSON.stringify(r.by['origin-lab']!.error)).toBe('pass');
    expect(r.by['origin-lab']!.executor.ssm?.length).toBeGreaterThan(0);
    const probe = r.by['api-probe']!;
    expect(probe.result, JSON.stringify(probe.error)).toBe('pass');
    expect(usedTokens.size).toBe(2);
    for (const t of usedTokens) expect(JSON.stringify(r.out.run)).not.toContain(t);
    const probeCalls = app.calls.filter((c) => c.url.startsWith('/api/lab/probe/now'));
    expect(probeCalls.every((c) => typeof c.headers['x-atl-probe-nonce'] === 'string')).toBe(true);
  }, 60_000);

  it('experiments and manual confirmations', async () => {
    const run = (label: string) => ({
      ...Keys.experimentRun(SID, `01JB3M2C8Y3T5Q6W7E8R9T0Y${label === 'before' ? '1A' : '1B'}`),
      type: 'ExperimentRun',
      runId: `01JB3M2C8Y3T5Q6W7E8R9T0Y${label === 'before' ? '1A' : '1B'}`,
      module: 'cdn',
      experiment: 'media-load',
      label,
      status: 'uploaded',
      scenario: 'media-load',
      summary: { params: { requests: 20 } },
      validity: { status: 'valid', reasons: [] },
      finishedAt: new Date(clock.nowMs()).toISOString(),
    });
    expect((await step('baseline')).by['exp-before']!.result).toBe('fail');
    store.seed(run('before'));
    store.seed(run('after'));
    expect((await step('baseline')).by['exp-before']!.result).toBe('pass');
    const confirm = await step('confirm');
    expect(confirm.by['confirm-mail']!.result).toBe('not_run');
    expect(confirm.state).toBe('needs_manual');
    store.seed({ ...Keys.manualConfirmation(SID, 'confirm', 'confirm-mail', '01JB3M2C8Y3T5Q6W7E8R9T0Y9Z'), type: 'ManualConfirmation', confirmationId: '01JB3M2C8Y3T5Q6W7E8R9T0Y9Z', observed: '收到了', note: '确认邮件已收到', result: 'manual', submittedBy: SUB, createdAt: new Date().toISOString() });
    const applied = await applyManualConfirmation(deps, store, { sessionId: SID, stepId: 'confirm', checkId: 'confirm-mail', confirmationId: '01JB3M2C8Y3T5Q6W7E8R9T0Y9Z' });
    expect(applied.applied).toBe(true);
    expect((await store.get<StepResultItem>(Keys.stepResult(SID, 'confirm')))!.state).toBe('done_manual');
    // a manual confirmation never replaces an automatic local result
    const denied = await applyManualConfirmation(deps, store, { sessionId: SID, stepId: 'enable-cdn', checkId: 'origin-ok', confirmationId: '01JB3M2C8Y3T5Q6W7E8R9T0Y9Z' });
    expect(denied.applied).toBe(false);
  }, 60_000);
});

describe('drift, submit, finalize', () => {
  async function completeEverything() {
    await step('orient');
    app.cdn = { driver: 'cloudfront', status: 'ok' };
    reaper.next = { status: 'FOUND', sessionId: SID, roleSessionName: `atl-${SID}-console`, eventId: 'ev1', eventName: 'CreateDistribution', eventTime: new Date(clock.nowMs() - 60_000).toISOString(), region: 'us-east-1' };
    await step('enable-cdn');
    for (const label of ['before', 'after']) {
      const runId = `01JB3M2C8Y3T5Q6W7E8R9T0Y${label === 'before' ? '2A' : '2B'}`;
      store.seed({ ...Keys.experimentRun(SID, runId), type: 'ExperimentRun', runId, module: 'cdn', experiment: 'media-load', label, status: 'uploaded', scenario: 'media-load', summary: { params: { r: 1 } }, validity: { status: 'valid', reasons: [] }, finishedAt: new Date().toISOString() });
    }
    await step('baseline');
    await step('after');
    store.seed({ ...Keys.manualConfirmation(SID, 'confirm', 'confirm-mail', '01JB3M2C8Y3T5Q6W7E8R9T0Y8Z'), type: 'ManualConfirmation', confirmationId: '01JB3M2C8Y3T5Q6W7E8R9T0Y8Z', observed: '收到了', note: '确认邮件已收到', result: 'manual', submittedBy: SUB });
    await applyManualConfirmation(deps, store, { sessionId: SID, stepId: 'confirm', checkId: 'confirm-mail', confirmationId: '01JB3M2C8Y3T5Q6W7E8R9T0Y8Z' });
    await stepAction(deps, store, { kind: 'skip', sessionId: SID, stepId: 'extras' });
  }

  it('a must-hold failure after a pass is drift; a passed once check stays passed', async () => {
    await completeEverything();
    app.cdn = { driver: 'direct', status: 'off' };
    const drifted = await step('enable-cdn', { checkIds: ['cap-cdn'] });
    expect(drifted.by['cap-cdn']!.result).toBe('fail');
    expect(drifted.state).toBe('drifted');
    const sr = (await store.get<StepResultItem>(Keys.stepResult(SID, 'enable-cdn')))!;
    expect(sr.driftEvents.at(-1)!.kind).toBe('runtime');
    expect(events.types()).toContain('step.drifted');
    app.cdn = { driver: 'cloudfront', status: 'ok' };
    const orient = await step('orient', { checkIds: ['cdn-off'] });
    expect(orient.by['cdn-off']!.result).toBe('fail');
    expect(orient.state).toBe('done');
    const sub = await submitAttempt(deps, engine(deps) as never, store, { sessionId: SID });
    expect(sub.attemptStatus).toBe('completed_manual');
  }, 120_000);

  it('submit with something missing returns the attempt to active and lists what is missing', async () => {
    await step('orient');
    const sub = await submitAttempt(deps, engine(deps) as never, store, { sessionId: SID });
    expect(sub.attemptStatus).toBe('active');
    expect((sub.missing as unknown[]).length).toBeGreaterThan(0);
  }, 120_000);

  it('FinalizeAttempt completes, grants the badge and is idempotent; void before READY', async () => {
    await completeEverything();
    const s = (await store.get<Record<string, unknown>>(Keys.labSession(SID)))!;
    await store.put({ ...(s as never), state: 'ENDING' });
    const out = await finalizeAttempt(deps, engine(deps) as never, store, { sessionId: SID, endReason: 'USER_ENDED' });
    expect(out.attemptStatus).toBe('completed_manual');
    expect(out.reportRevision).toBe(1);
    expect(out.certificateEligible).toBe(true);
    const progress = (await store.get<LabProgressItem>(Keys.labProgress(SUB, LAB_ID)))!;
    expect(progress.status).toBe('completed_manual');
    expect(progress.badge?.status).toBe('valid');
    expect(progress.badge?.level).toBe('verified');
    expect(progress.credits.map((c) => c.serviceId)).toEqual(['cloudfront']);
    expect(events.types()).toContain('badge.earned');
    const again = await finalizeAttempt(deps, engine(deps) as never, store, { sessionId: SID, endReason: 'USER_ENDED' });
    expect(again.attemptStatus).toBe(out.attemptStatus);
    expect(again.checkRunId).toBe(out.checkRunId);
    // a session that never reached READY gives a void attempt
    seed();
    const s2 = (await store.get<Record<string, unknown>>(Keys.labSession(SID)))!;
    await store.put({ ...(s2 as never), state: 'ENDING', readyAt: null });
    await store.delete(Keys.labAttempt(SID));
    expect((await finalizeAttempt(deps, engine(deps) as never, store, { sessionId: SID })).attemptStatus).toBe('void');
    expect((await store.get<LabAttemptItem>(Keys.labAttempt(SID)))!.status).toBe('void');
  }, 180_000);

  it('the handler never throws FinalizeAttempt errors into the end workflow', async () => {
    const handler = createChecksHandler(async () => deps, undefined, () => engine(deps) as never);
    const r = (await handler({ action: 'FinalizeAttempt', sessionId: 'sbadbadbadbad', endReason: 'EXPIRED' })) as { attemptStatus: string };
    expect(r.attemptStatus).toBe('unverified');
    await expect(handler({ action: 'NoSuchAction' })).rejects.toThrow(/not implemented/);
  });
});

describe('health gates and cleanup verification', () => {
  it('caps.profile gate accepts expected warnings only', async () => {
    const ok = await healthGate(deps, engine(deps) as never, store, { sessionId: SID, gates: ['caps.profile'], expect: { iam: 'role', auth: '*' }, expectedWarnings: ['DEP-013'] });
    expect(ok.ok).toBe(true);
    const bad = await healthGate(deps, engine(deps) as never, store, { sessionId: SID, gates: ['caps.profile'], expect: { iam: 'role', auth: '*' }, expectedWarnings: [] });
    expect(bad.ok).toBe(false);
  }, 60_000);

  it('lifecycle contracts: Preflight (default VPC, baseline inventory) and RunHealthGate (PASS / FAIL)', async () => {
    const { preflight, runHealthGate } = await import('../src/functions/checks/lifecycle-gates.js');
    const ok = (await preflight(deps, engine(deps) as never, store, { sessionId: SID, envId: ENV_ID, fresh: true, baseline: true })) as { result: string; items: { id: string }[] };
    expect(await store.get(Keys.inventorySnapshot(ENV_ID))).toMatchObject({ count: 0 });
    // the baseline is stored in the shape the reclaimer's INVENTORY difference reads ({ type, id, arn, region })
    engine.aws.on('tag:GetResources', { ResourceTagMappingList: [{ ResourceARN: 'arn:aws:ec2:ap-northeast-1:111122223333:instance/i-0owner00000000001' }, { ResourceARN: 'arn:aws:rds:ap-northeast-1:111122223333:db:owner-db' }] });
    const ENV2 = '01jc9x3k9cq4m2x8n5b6c0d1zz';
    await preflight(deps, engine(deps) as never, store, { sessionId: SID, envId: ENV2, fresh: true, baseline: true });
    const snap = (await store.get<{ items: unknown[]; regions: string[]; resourceArns: string[] }>(Keys.inventorySnapshot(ENV2)))!;
    expect(snap.items).toEqual(
      expect.arrayContaining([
        { type: 'AWS::EC2::Instance', id: 'i-0owner00000000001', arn: 'arn:aws:ec2:ap-northeast-1:111122223333:instance/i-0owner00000000001', region: 'ap-northeast-1' },
        { type: 'AWS::RDS::DBInstance', id: 'owner-db', arn: 'arn:aws:rds:ap-northeast-1:111122223333:db:owner-db', region: 'ap-northeast-1' },
      ]),
    );
    expect(snap.regions).toEqual(expect.arrayContaining(['ap-northeast-1', 'us-east-1']));
    engine.aws.on('tag:GetResources', { ResourceTagMappingList: [] });
    expect(['PASS', 'WARN']).toContain(ok.result);
    engine.aws.on('ec2:DescribeVpcs', { Vpcs: [] });
    const noVpc = (await preflight(deps, engine(deps) as never, store, { sessionId: SID, envId: ENV_ID, fresh: false })) as { result: string; failureCode: string };
    expect(noVpc).toMatchObject({ result: 'FAIL', failureCode: 'PREFLIGHT_NO_DEFAULT_VPC' });
    engine.aws.on('ec2:DescribeVpcs', { Vpcs: [{ VpcId: 'vpc-1', IsDefault: true }] });
    const pass = await runHealthGate(deps, engine(deps) as never, store, { sessionId: SID, envId: ENV_ID, gates: ['caps.profile', 'ws.ready'], expectedWarnings: ['DEP-013'], targetModules: [{ id: 'cdn', from: 'direct', to: 'cloudfront' }] });
    expect(pass.status).toBe('PASS');
    app.cdn = { driver: 'direct', status: 'error' };
    const { healthGate } = await import('../src/functions/checks/flows.js');
    const fail = await healthGate(deps, engine(deps) as never, store, { sessionId: SID, gates: ['caps.profile'], expect: { iam: '*', cdn: '*' }, expectedWarnings: [] });
    expect(fail.ok).toBe(false);
  }, 60_000);

  it('cleanup.verify runs only aws-readonly expectError checks after the session ended', async () => {
    const s = (await store.get<Record<string, unknown>>(Keys.labSession(SID)))!;
    await store.put({ ...(s as never), state: 'ENDED' });
    const r = await cleanupVerify(deps, engine(deps) as never, store, SID);
    expect(r.results).toEqual([{ checkKey: `${LAB_ID}/dist-gone`, result: 'pass' }]);
  });
});
