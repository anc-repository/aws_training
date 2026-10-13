import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FaultScheduler, resolveVia, ssmSendCommandArgs, type FaultExecutor } from '../_lib/faults.js';
import { closeSharedDispatcher, ExpClient } from '../_lib/http.js';
import { generateReport, parseReportArgs } from '../_lib/report.js';
import { EXIT, parseRunnerArgs, runExperiment, type RunnerDeps } from '../_lib/runner.js';
import { validateResult } from '../_lib/schema.js';
import { readCachedToken, resolveAdminToken, resolveTarget, writeCachedToken } from '../_lib/session.js';
import type { FaultSpec, ResultDoc } from '../_lib/types.js';
import { startMockServer, type MockServer } from './mock-server.js';

let mock: MockServer;
const tmp = mkdtempSync(path.join(os.tmpdir(), 'exp-runner-'));
const out = path.join(tmp, 'results');
const logs: string[] = [];

function deps(extra: Partial<RunnerDeps> = {}): RunnerDeps {
  return { env: { CLOUDALBUM_ADMIN_TOKEN: mock.adminToken }, repo: tmp, log: (l) => logs.push(l), ...extra };
}

function args(argv: string[]) {
  return parseRunnerArgs([...(argv.includes('--warmup') ? [] : ['--warmup', '0s']), ...argv, '--target', mock.url, '--out', out]);
}

beforeAll(async () => {
  mock = await startMockServer({ processingMs: 30 });
});

afterAll(async () => {
  await mock.close();
  await closeSharedDispatcher();
  rmSync(tmp, { recursive: true, force: true });
});

describe('parseRunnerArgs', () => {
  it('parses the §8.2 command line', () => {
    const a = parseRunnerArgs(['queue', '--label', 'after', '--scenario', 'upload-burst', '--vus', '10,50', '--duration', '60s', '--repeat', '3', '--ab', '--upload', '--force', '--param', 'count=5']);
    expect(a).toMatchObject({ module: 'queue', label: 'after', scenario: 'upload-burst', vus: [10, 50], duration: '60s', repeat: 3, ab: true, upload: true, force: true, params: { count: '5' } });
    expect(() => parseRunnerArgs(['queue', '--vus', '0'])).toThrow();
    expect(() => parseRunnerArgs(['queue', '--repeat', '99'])).toThrow();
    expect(() => parseRunnerArgs(['queue', '--duration', 'forever'])).toThrow();
    expect(() => parseRunnerArgs(['queue', '--nope'])).toThrow();
  });
});

describe('runner against the mock server', () => {
  it('runs cache feed-read with --ab: experiment headers, alternating bypass, server metrics, schema-valid result file', async () => {
    const before = mock.requests.length;
    const r = await runExperiment(args(['cache', '--label', 'memory', '--scenario', 'feed-read', '--ab', '--vus', '3', '--duration', '600ms', '--warmup', '200ms']), deps());
    expect(r.code, r.message).toBe(EXIT.ok);
    const doc = r.result!;
    expect(r.file && existsSync(r.file)).toBe(true);
    expect(path.basename(r.file!)).toMatch(/^\d{8}T\d{6}Z__memory__[0-9A-Z]{26}\.json$/);
    expect(validateResult(JSON.parse(readFileSync(r.file!, 'utf8'))).errors).toEqual([]);
    expect(doc.forced).toBe(false);
    expect(doc.requiresCheck).toEqual({ label: 'memory', ok: true, mismatches: [] });
    expect(mock.runs.has(doc.runId)).toBe(true);
    expect(mock.runs.get(doc.runId)!.finishedAt).toBeDefined();

    const reqs = mock.requests.slice(before).filter((q) => q.path === '/api/feed');
    const measured = reqs.filter((q) => q.runId === doc.runId);
    const warm = reqs.filter((q) => !q.runId);
    expect(warm.length).toBeGreaterThan(0);
    expect(warm.every((q) => !q.bypass)).toBe(true);
    expect(measured.length).toBeGreaterThan(4);
    expect(new Set(measured.map((q) => q.label))).toEqual(new Set(['memory:A', 'memory:B']));
    expect(measured.filter((q) => q.label === 'memory:A').every((q) => q.bypass === 'cache')).toBe(true);
    expect(measured.filter((q) => q.label === 'memory:B').every((q) => !q.bypass)).toBe(true);

    expect(Object.keys(doc.client.byVariant!)).toEqual(['memory:A', 'memory:B']);
    expect(doc.client.byVariant!['memory:A']!.serverTiming!.database!.callsPerRequest).toBe(3);
    expect(doc.client.byVariant!['memory:B']!.serverTiming!.database).toBeUndefined();
    expect(doc.client.outcomes!.cache).toMatchObject({ 'memory:bypass': expect.any(Number), 'memory:hit': expect.any(Number) });
    expect(doc.scenario!.findings.feed).toBeDefined();
    expect(doc.server.available).toBe(true);
    expect(doc.server.routes['GET /api/feed']!.count).toBe(measured.length);
    expect(Object.keys(doc.server.paths!).some((k) => k.includes('bypass=cache'))).toBe(true);
    expect(doc.server.ports.cache!.driver).toBe('memory');
    expect(doc.server.host).toMatchObject({ samples: 3, netRxBytes: 50_000 });
    expect(doc.server.origin!.direct).toBeGreaterThan(0);
    expect(doc.environment.drivers.cache).toBe('memory');
    expect(doc.spec!.expect!.length).toBeGreaterThan(0);
    expect(doc.notes).toMatch(/A = 带 X-Compare-Bypass: cache/);

    // A/B 报告：缺省 pair = memory:A,memory:B
    const rep = generateReport(parseReportArgs(['cache', '--experiment', 'feed-read', '--results', out, '--out', path.join(tmp, 'reports')]));
    expect(rep.data.pair).toEqual(['memory:A', 'memory:B']);
    const db = rep.data.expectations.find((e) => e.metric === 'client.timing.database.calls_per_request')!;
    expect(db).toMatchObject({ before: 3, after: 0, verdict: 'pass' });
  });

  it('refuses to run when requires[label] does not match, and records forced runs', async () => {
    const refused = await runExperiment(args(['cache', '--label', 'after', '--scenario', 'feed-read', '--duration', '100ms']), deps());
    expect(refused.code).toBe(EXIT.requires);
    expect(refused.message).toMatch(/cache\.driver: 期望 "redis"，实际 "memory"/);
    expect(refused.result).toBeUndefined();

    const forced = await runExperiment(args(['cache', '--label', 'after', '--scenario', 'feed-read', '--duration', '200ms', '--force', '--upload']), deps());
    expect(forced.code).toBe(EXIT.ok);
    expect(forced.result!.forced).toBe(true);
    expect(forced.result!.warnings!.join('\n')).toMatch(/强制运行/);
    expect(mock.results.some((x) => x.runId === forced.result!.runId)).toBe(true);
  });

  it('reports usage / target / token problems with distinct exit codes', async () => {
    expect((await runExperiment(args(['cache', '--label', 'after', '--scenario', 'nope']), deps())).code).toBe(EXIT.usage);
    expect((await runExperiment(args(['cache', '--label', 'Bad']), deps())).code).toBe(EXIT.usage);
    expect((await runExperiment(args(['queue', '--label', 'after', '--scenario', 'upload-burst', '--ab', '--param', 'bogus=1']), deps())).code).toBe(EXIT.usage);
    expect((await runExperiment(args(['storage', '--label', 'before', '--ab']), deps())).message).toMatch(/不支持 --ab/);
    const noToken = await runExperiment(args(['cache', '--label', 'memory', '--scenario', 'feed-read']), deps({ env: {} }));
    expect(noToken.code).toBe(EXIT.target);
    expect(noToken.message).toMatch(/没有管理员令牌/);
    const notAdmin = await runExperiment(args(['cache', '--label', 'memory', '--scenario', 'feed-read']), deps({ env: { CLOUDALBUM_ADMIN_TOKEN: 'someone-else' } }));
    expect(notAdmin.code).toBe(EXIT.target);
    expect(notAdmin.message).toMatch(/public 视图/);
    const manual = await runExperiment(args(['queue', '--label', 'after', '--scenario', 'poison']), deps());
    expect(manual.code).toBe(EXIT.ok);
    expect(manual.message).toMatch(/手工实验/);
    const listed: string[] = [];
    expect((await runExperiment(args(['cache', '--list']), deps({ log: (l) => listed.push(l) }))).code).toBe(EXIT.ok);
    expect(listed.some((l) => l.startsWith('feed-read'))).toBe(true);
  });

  it('logs in with CLOUDALBUM_ADMIN_EMAIL / PASSWORD when no token is given', async () => {
    const r = await runExperiment(args(['auth', '--label', 'before', '--scenario', 'feature-matrix']),
      deps({ env: { CLOUDALBUM_ADMIN_EMAIL: 'admin@example.test', CLOUDALBUM_ADMIN_PASSWORD: 'secret' } }));
    expect(r.code, r.message).toBe(EXIT.ok);
    expect(r.result!.scenario!.findings.matrix).toMatchObject({ driver: 'local', mfa: 'optional' });
  });

  it('runs the queue upload burst with scheduled faults, waits for READY and computes business metrics', async () => {
    mock.setDriver('queue', 'memory');
    mock.setDriver('image-processing', 'worker');
    const fired: FaultSpec[] = [];
    const executor: FaultExecutor = async (spec) => {
      fired.push(spec);
      return { via: 'test', exitCode: 0 };
    };
    try {
      const r = await runExperiment(args(['queue', '--label', 'before', '--scenario', 'upload-burst', '--vus', '2', '--duration', '1s',
        '--param', 'count=4', '--param', 'width=64', '--param', 'height=48', '--param', 'drainTimeoutSec=10']), deps({ faultExecutor: executor }));
      expect(r.code, r.message).toBe(EXIT.ok);
      const doc = r.result!;
      expect(doc.client.latencyMs['POST /api/photos/:id/complete']!.count).toBe(4);
      expect(doc.client.latencyMs['PUT /api/storage/upload']!.count).toBe(4);
      expect(doc.server.business).toMatchObject({ photosUploaded: 4, jobsLost: 0, uploadErrors: 0 });
      expect(doc.server.business.photoTimeToReadyP95).toBeGreaterThanOrEqual(0);
      // 第 30 秒的故障在 1 秒的测量里来不及触发：记为跳过
      expect(doc.faults).toEqual([expect.objectContaining({ at: '30s', script: 'faults/restart-api.sh', skipped: true })]);
      expect(fired).toEqual([]);
      // cleanup 端点 501 → 逐个删除
      expect(doc.notes).toMatch(/清理：逐个删除 \d+ 个资源/);
    } finally {
      mock.setDriver('queue', 'sync');
      mock.setDriver('image-processing', 'inline');
    }
  });
});

describe('faults', () => {
  it('fires start / timed / end faults and api faults', async () => {
    const client = new ExpClient({ base: mock.url, token: mock.adminToken, recording: false });
    const fired: string[] = [];
    const sched = new FaultScheduler([
      { at: 'start', script: 'faults/a.sh' },
      { at: '50ms', api: { type: 'latency', target: 'database', ms: 100, durationSec: 5 } },
      { at: 'end', script: 'faults/b.sh', args: ['release'] },
      { at: '10s', manual: '人工操作' },
    ], { moduleDir: '.', client, via: 'skip', log: () => undefined }, async (spec, ctx) => {
      fired.push(spec.script ?? (spec.api ? 'api' : 'manual'));
      if (spec.api) {
        const res = await ctx.client.post('/api/lab/faults', { json: spec.api });
        return { via: 'api', exitCode: res.ok ? 0 : 1 };
      }
      return { via: 'test', exitCode: 0 };
    });
    sched.start(200);
    await new Promise((r) => setTimeout(r, 120));
    await sched.runEnd();
    const records = await sched.stop();
    expect(fired).toEqual(['faults/a.sh', 'api', 'faults/b.sh']);
    expect(records.find((r) => r.at === '10s')).toMatchObject({ skipped: true });
    expect(mock.faults.at(-1)).toMatchObject({ type: 'latency', target: 'database' });
  });

  it('resolves the delivery channel and builds SSM arguments without calling AWS', () => {
    expect(resolveVia({ at: '1s', api: {} }, { via: 'auto' })).toBe('api');
    expect(resolveVia({ at: '1s', script: 'x.sh' }, { via: 'auto', ssh: 'ec2-user@h' })).toBe('ssh');
    expect(resolveVia({ at: '1s', script: 'x.sh' }, { via: 'auto', instanceId: 'i-1' })).toBe('ssm');
    expect(resolveVia({ at: '1s', script: 'x.sh' }, { via: 'auto' }, 'win32')).toBe('skip');
    expect(resolveVia({ at: '1s', script: 'x.sh' }, { via: 'auto' }, 'linux')).toBe('local');
    expect(resolveVia({ at: '1s', script: 'x.sh', via: 'local' }, { via: 'ssh', ssh: 'h' })).toBe('local');
    const a = ssmSendCommandArgs('#!/bin/bash\necho hi\n', ["it's"], 'i-123', 'ap-northeast-1');
    expect(a.slice(0, 6)).toEqual(['ssm', 'send-command', '--instance-ids', 'i-123', '--document-name', 'AWS-RunShellScript']);
    const params = JSON.parse(a[a.indexOf('--parameters') + 1]!) as { commands: string[] };
    expect(params.commands[0]).toContain(Buffer.from('#!/bin/bash\necho hi\n').toString('base64'));
    expect(params.commands[0]).toContain(`'it'\\''s'`);
    expect(a).toContain('--region');
  });
});

describe('session', () => {
  it('resolves the target and caches tokens per target', async () => {
    expect(resolveTarget('http://x:3000/', {}, tmp)).toBe('http://x:3000');
    expect(resolveTarget(undefined, { EXP_TARGET: 'https://album.example.com' }, tmp)).toBe('https://album.example.com');
    expect(resolveTarget(undefined, {}, tmp)).toBe('http://localhost:3000');
    expect(() => resolveTarget('ftp://x', {}, tmp)).toThrow();
    writeCachedToken(mock.url, mock.adminToken, tmp);
    expect(readCachedToken(mock.url, tmp)).toBe(mock.adminToken);
    expect(readCachedToken('http://other', tmp)).toBeUndefined();
    expect(readCachedToken(mock.url, tmp, Date.now() + 3600_000)).toBeUndefined();
    expect((await resolveAdminToken({ target: mock.url, env: {}, root: tmp })).source).toBe('cache');
    expect((await resolveAdminToken({ target: mock.url, token: 't', env: {}, root: tmp })).source).toBe('arg');
  });
});

export type { ResultDoc };
