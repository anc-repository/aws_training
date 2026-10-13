/**
 * 每个 node 场景都对 mock 服务器跑一次（短时长、小参数、--force 跳过前置条件），确认能跑完、结果符合 schema、关键发现存在。
 * 故障脚本由测试执行器代替（不执行任何 shell / AWS CLI）。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FaultExecutor } from '../_lib/faults.js';
import { closeSharedDispatcher } from '../_lib/http.js';
import { loadManifest } from '../_lib/manifest.js';
import { EXIT, parseRunnerArgs, runExperiment } from '../_lib/runner.js';
import { validateResult } from '../_lib/schema.js';
import type { ResultDoc } from '../_lib/types.js';
import { experimentsRoot } from '../_lib/util.js';
import { startMockServer, type MockServer } from './mock-server.js';

let mock: MockServer;
const tmp = mkdtempSync(path.join(os.tmpdir(), 'exp-scenarios-'));
const usersCsv = path.join(tmp, 'users.csv');
const executor: FaultExecutor = async () => ({ via: 'test', exitCode: 0 });

beforeAll(async () => {
  mock = await startMockServer({ processingMs: 20 });
  writeFileSync(usersCsv, 'email,password\nuser1@example.test,pw\nuser2@example.test,pw\n');
});

afterAll(async () => {
  await mock.close();
  await closeSharedDispatcher();
  rmSync(tmp, { recursive: true, force: true });
});

/** 每个实验的测试参数（缺省：--vus 2 --duration 400ms）。 */
const OVERRIDES: Record<string, string[]> = {
  'cache/cache-stampede': ['--param', 'rounds=2', '--param', 'burst=5', '--param', 'pauseMs=0', '--duration', '2s'],
  'cache/stale-read': ['--param', 'ttlSec=1', '--param', 'intervalMs=100', '--duration', '2s'],
  'queue/upload-burst': ['--param', 'count=3', '--param', 'width=64', '--param', 'height=48', '--param', 'drainTimeoutSec=5'],
  'image-processing/upload-burst': ['--param', 'count=2', '--param', 'width=96', '--param', 'height=64', '--param', 'drainTimeoutSec=5'],
  'image-processing/neighbor': ['--param', 'width=96', '--param', 'height=64', '--param', 'feedRps=20', '--param', 'drainTimeoutSec=5'],
  'image-processing/failures': ['--param', 'timeoutSec=5'],
  'storage/upload-burst': ['--param', 'fileMb=0.2', '--param', 'width=64', '--param', 'height=48', '--param', 'feedRps=10', '--param', 'drainTimeoutSec=5'],
  'storage/ebs-growth': ['--param', 'settleSec=0', '--param', 'attempts=2', '--duration', '2s'],
  'database/failover': ['--param', 'intervalMs=50', '--duration', '500ms'],
  'database/replica-lag': ['--param', 'intervalMs=50'],
  'auth/login-storm': ['--param', `users=${usersCsv}`],
  'auth/brute-force': ['--param', 'attempts=7', '--param', 'intervalMs=0', '--duration', '5s'],
  'auth/revoke': ['--param', 'user=user9@example.test:pw', '--param', 'intervalSec=1', '--duration', '3s'],
  'auth/cross-instance': ['--param', 'n=6'],
  'auth/token-claims': ['--param', 'user=user3@example.test:pw'],
  'cdn/ttfb': ['--param', 'samples=2', '--param', 'cdn=__CDN__'],
  'cdn/api-nocache': ['--param', 'samples=1', '--param', 'cdn=__CDN__'],
  'cdn/compression': ['--param', 'cdn=__CDN__'],
  'cdn/media-load': ['--param', 'cdn=__CDN__', '--param', 'thumbs=3'],
  'iam/long-run': ['--param', 'rps=5'],
  'iam/revoke': ['--param', 'rps=5'],
};

const root = experimentsRoot();
const cases: Array<{ module: string; id: string; label: string; tool: string }> = [];
for (const module of ['iam', 'storage', 'cdn', 'auth', 'queue', 'image-processing', 'cache', 'database']) {
  for (const e of loadManifest(module, root).experiments) {
    if (e.scenario.tool !== 'node') continue;
    cases.push({ module, id: e.id, label: Object.keys(e.requires ?? {})[0] ?? 'before', tool: e.scenario.tool });
  }
}

describe.each(cases)('$module/$id', ({ module, id, label }) => {
  it('runs against the mock server and writes a schema-valid result', async () => {
    const key = `${module}/${id}`;
    const cdn = mock.url.replace('127.0.0.1', 'localhost');
    const extra = (OVERRIDES[key] ?? []).map((a) => a.replace('__CDN__', cdn));
    const argv = [module, '--scenario', id, '--label', label, '--vus', '2', '--duration', '400ms', '--warmup', '0s', '--force', '--target', mock.url, '--out', path.join(tmp, 'results'), ...extra];
    const lines: string[] = [];
    const r = await runExperiment(parseRunnerArgs(argv), {
      env: { CLOUDALBUM_ADMIN_TOKEN: mock.adminToken, CLOUDALBUM_ADMIN_EMAIL: 'admin@example.test', CLOUDALBUM_ADMIN_PASSWORD: 'secret' },
      repo: tmp, faultExecutor: executor, log: (l) => lines.push(l),
    });
    expect(r.code, `${r.message ?? ''}\n${lines.join('\n')}`).toBe(EXIT.ok);
    const doc = r.result as ResultDoc;
    expect(validateResult(doc).errors).toEqual([]);
    expect(doc.module).toBe(module);
    expect(doc.experiment).toBe(id);
    expect(doc.warnings?.filter((w) => w.startsWith('场景出错')) ?? []).toEqual([]);
    expect(Object.keys(doc.scenario?.findings ?? {}).length + (doc.notes ? 1 : 0), 'findings 或 notes').toBeGreaterThan(0);
    CHECKS[key]?.(doc);
  }, 30_000);
});

const CHECKS: Record<string, (doc: ResultDoc) => void> = {
  'cache/cache-stampede': (d) => {
    expect(d.scenario!.findings.burst).toBe(5);
    expect(d.scenario!.findings.dbCallsPerBurst).toBe(2);
  },
  'cache/stale-read': (d) => expect(d.scenario!.findings.staleRatio).toBe(0),
  'queue/upload-burst': (d) => expect(d.server.business).toMatchObject({ photosUploaded: 3, jobsLost: 0 }),
  'image-processing/failures': (d) => expect(d.scenario!.findings.uploaded).toBe(1),
  'image-processing/neighbor': (d) => expect((d.scenario!.findings.feedUnderLoad as { requests: number }).requests).toBeGreaterThan(0),
  'storage/upload-burst': (d) => {
    expect(d.scenario!.findings.uploadPath).toBe('via-ec2');
    expect(d.client.latencyMs['PUT /api/storage/upload']!.count).toBeGreaterThan(0);
  },
  'storage/ebs-growth': (d) => {
    expect(d.faults.map((f) => f.at)).toEqual(['start', 'end']);
    expect(d.scenario!.findings.uploadOk).toBe(2);
  },
  'storage/upload-sidebyside': (d) => expect(d.scenario!.findings.endpointAvailable).toBe(false),
  'database/mixed-rw': (d) => expect(d.client.latencyMs['GET /api/feed']).toBeDefined(),
  'database/failover': (d) => {
    expect(d.scenario!.findings.failures).toBe(0);
    expect(d.scenario!.findings.attempts as number).toBeGreaterThan(2);
    expect(d.faults.every((f) => f.skipped)).toBe(true);
  },
  'database/replica-lag': (d) => expect(d.scenario!.findings.endpointAvailable).toBe(false),
  'auth/login-storm': (d) => {
    expect(d.scenario!.findings.loginOk as number).toBeGreaterThan(0);
    expect(d.client.latencyMs['POST /api/auth/login']).toBeDefined();
    expect(d.client.serverTiming!.auth).toBeDefined();
  },
  'auth/brute-force': (d) => {
    expect(d.scenario!.findings.sequence).toBe('401×5, 423×2');
    expect(d.scenario!.findings.firstRejectAttempt).toBe(6);
  },
  'auth/revoke': (d) => {
    expect(d.scenario!.findings.rejected).toBe(1);
    expect(d.scenario!.findings.beforeLogoutStatus).toBe(200);
  },
  'auth/cross-instance': (d) => expect(d.scenario!.findings.perInstance).toEqual({ 'i-mock': { ok: 6, fail: 0 } }),
  'auth/token-claims': (d) => {
    expect(d.scenario!.findings.header).toMatchObject({ alg: 'ES256' });
    expect(d.scenario!.findings.jwks).toMatchObject({ keys: 1, matchesKid: true });
  },
  'auth/cloc': (d) => expect((d.scenario!.findings.local as { files: number }).files).toBeGreaterThanOrEqual(0),
  'cdn/ttfb': (d) => {
    expect(Object.keys(d.client.byTarget!).sort()).toEqual(['cdn', 'direct']);
    expect(d.scenario!.findings.resource).toBe('/assets/index-abc.js');
  },
  'cdn/api-nocache': (d) => expect(d.scenario!.findings.labNow).toMatchObject({ available: true, cached: 0 }),
  'cdn/compression': (d) => expect(d.scenario!.findings.totalBytes).toMatchObject({ direct: expect.any(Number), cdn: expect.any(Number) }),
  'cdn/media-load': (d) => expect(d.scenario!.findings.iterations as number).toBeGreaterThan(0),
  'iam/whoami': (d) => expect(d.scenario!.findings).toMatchObject({ driver: 'none', credentialSource: 'none', awsSdkLoaded: 0, longTermKeysOnDisk: 0 }),
  'iam/long-run': (d) => expect(d.scenario!.findings.endpointAvailable).toBe(false),
};
