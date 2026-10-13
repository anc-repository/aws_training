/**
 * The lab-side check bundle (platform/checks, 04 §6): build + manifest digest, launcher and runner parameter gates,
 * integrity (tampered file → RUNNER_INTEGRITY), batch mode and aliases, args schemas, result lines and truncation, and
 * the checks that run against a local CloudAlbum stand-in (http-probe with the local probe token, capabilities,
 * caps.profile) plus the nginx log summary.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REPO_ROOT, tmpDir } from './helpers.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- decoded JSON results are asserted structurally
type Rec = any;

const CHECKS = path.join(REPO_ROOT, 'platform', 'checks');
const SID = 's4k7m2q9x1abc';
const TOKEN = 'abcdefghijklmnopqrstuvwx';

let out: string;
let digest: string;
let appRoot: string;
let server: http.Server;
let baseUrl: string;
const seen: { path: string; headers: http.IncomingHttpHeaders }[] = [];

function b64(v: unknown): string {
  return Buffer.from(JSON.stringify(v)).toString('base64url');
}

/** Async spawn: the stand-in HTTP server lives in this process and must keep serving while the runner works. */
async function run(env: Record<string, string>, launcher = path.join(out, 'atl', 'bin', 'atl-check.mjs')) {
  const r = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [launcher], { env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
  const lines = (r.stdout ?? '')
    .split(/\r?\n/)
    .filter((l) => l.startsWith('ATL-RESULT-V1 '))
    .map((l) => JSON.parse(Buffer.from(l.slice('ATL-RESULT-V1 '.length), 'base64url').toString('utf8')) as Rec);
  return { status: r.status, lines, stderr: r.stderr };
}

function ssm(checkId: string, args: unknown, extra: Record<string, string> = {}): Record<string, string> {
  return {
    SSM_CheckId: checkId,
    SSM_ArgsB64: b64(args),
    SSM_RunToken: TOKEN,
    SSM_SessionId: SID,
    SSM_BundleDigest: digest,
    SSM_TimeoutSec: '20',
    ATL_DEV_MODE: '1',
    ATL_DEV_INSTANCE_ID: 'i-dev-etest001-lab',
    ATL_DEV_APP_BASE_URL: baseUrl,
    ATL_DEV_APP_ROOT: appRoot,
    ...extra,
  };
}

beforeAll(async () => {
  out = tmpDir('bundle-');
  const { buildBundle } = (await import(pathToFileURL(path.join(CHECKS, 'build.mjs')).href)) as { buildBundle: (o: { outDir: string; createdAt: string }) => Promise<{ bundleDigest: string }> };
  digest = (await buildBundle({ outDir: out, createdAt: '2026-10-14T00:00:00.000Z' })).bundleDigest;
  appRoot = tmpDir('app-');
  fs.mkdirSync(path.join(appRoot, 'etc', 'atl'), { recursive: true });
  fs.mkdirSync(path.join(appRoot, 'etc', 'modules.d'), { recursive: true });
  fs.writeFileSync(path.join(appRoot, 'etc', 'atl', 'probe.token'), 'atlpk1.local-secret\n');
  fs.writeFileSync(path.join(appRoot, 'etc', 'modules.d', 'cdn.env'), 'CDN_ORIGIN_PORT=8080\nCDN_ORIGIN_SECRET=xyz\n');
  server = http.createServer((req, res) => {
    seen.push({ path: req.url ?? '', headers: req.headers });
    if (req.url?.startsWith('/api/lab/probe/now')) {
      if (req.headers['x-atl-probe-token'] !== 'atlpk1.local-secret') {
        res.writeHead(401).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'private, no-store', 'x-cloudalbum-path': 'entry=nginx;inst=i-dev;az=apne1-az1' });
      res.end(JSON.stringify({ now: 'T1' }));
      return;
    }
    if (req.url?.startsWith('/api/capabilities')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          app: { entry: { baseUrl } },
          modules: { iam: { driver: 'role', status: 'ok', localHealth: 'ok' }, auth: { driver: 'local', status: 'degraded', localHealth: 'ok' }, cdn: { driver: 'direct', status: 'off', localHealth: 'ok' } },
          validation: { errors: [], warnings: [{ rule: 'DEP-013', modules: ['auth'], message: 'outbox' }] },
        }),
      );
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain', 'x-cloudalbum-path': 'entry=nginx' }).end('ok');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 60_000);

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  fs.rmSync(out, { recursive: true, force: true });
  fs.rmSync(appRoot, { recursive: true, force: true });
});

describe('check bundle build', () => {
  it('names the directory after the SHA-256 of manifest.json and lists every file with its digest', async () => {
    const dir = path.join(out, 'atl', 'checks', digest);
    const manifest = fs.readFileSync(path.join(dir, 'manifest.json'));
    expect(createHash('sha256').update(manifest).digest('hex')).toBe(digest);
    const m = JSON.parse(manifest.toString('utf8')) as { purpose: string; files: Record<string, string>; checks: string[]; aliases: Record<string, string> };
    expect(m.purpose).toBe('atl-checkbundle/v1');
    for (const id of ['imds-get', 'http-probe', 'capability-snapshot', 'nginx-log-summary', 'base.ready', 'caps.profile', 'ws.ready', 'atl.channel', 'probe-token', 'lab-metrics-run', 'path-seen', 'app-stat']) expect(m.checks).toContain(id);
    expect(m.aliases['atl.capabilities']).toBe('capability-snapshot');
    for (const [rel, d] of Object.entries(m.files)) expect(`sha256:${createHash('sha256').update(fs.readFileSync(path.join(dir, rel))).digest('hex')}`).toBe(d);
    expect(fs.existsSync(path.join(out, 'atl', 'bin', 'atl-check'))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(out, 'bundle.json'), 'utf8')).bundleDigest).toBe(digest);
  });
});

describe('launcher and runner gates (04 §6.1, §6.3)', () => {
  it('missing ENV_VAR parameters → RUNNER_UNAVAILABLE; bad patterns → RUNNER_INTEGRITY', async () => {
    const env = ssm('env-key', { module: 'cdn', key: 'CDN_ORIGIN_PORT' });
    delete (env as Record<string, string | undefined>).SSM_RunToken;
    const r1 = await run(env);
    expect(r1.status).not.toBe(0);
    expect(r1.lines[0]!.errorCode).toBe('RUNNER_UNAVAILABLE');
    const r2 = await run(ssm('env-key;rm -rf /', { module: 'cdn', key: 'X' }));
    expect(r2.lines[0]!.errorCode).toBe('RUNNER_INTEGRITY');
    const r3 = await run(ssm('env-key', { module: 'cdn', key: 'X' }, { SSM_BundleDigest: 'f'.repeat(64) }));
    expect(r3.lines[0]!.errorCode).toBe('RUNNER_INTEGRITY');
  });

  it('runs a batch: aliases, unknown ids, rejected args, secret env keys only report presence', async () => {
    const r = await run(
      ssm('batch', {
        items: [
          { key: 'a', checkId: 'env-key', args: { module: 'cdn', key: 'CDN_ORIGIN_PORT' } },
          { key: 'b', checkId: 'env-key', args: { module: 'cdn', key: 'CDN_ORIGIN_SECRET' } },
          { key: 'c', checkId: 'imds-get', args: { path: 'iam/security-credentials/CloudAlbumAppRole' } },
          { key: 'd', checkId: 'no-such-check', args: {} },
          { key: 'e', checkId: 'env-key', args: { module: '../etc', key: 'X' } },
          { key: 'f', checkId: 'imds-get', args: { path: 'instance-id' } },
        ],
      }),
    );
    expect(r.status).toBe(0);
    const by = Object.fromEntries(r.lines.map((l) => [l.key, l]));
    expect(by.a.observed).toEqual({ present: true, value: '8080' });
    expect(by.b.observed).toEqual({ present: true, secret: true });
    expect(by.c.errorCode).toBe('NOT_ALLOWED');
    expect(by.d.errorCode).toBe('NOT_ALLOWED');
    expect(by.e.errorCode).toBe('NOT_ALLOWED');
    expect(by.f.observed.value).toBe('i-dev-etest001-lab');
    for (const l of r.lines) {
      expect(l.runToken).toBe(TOKEN);
      expect(l.sessionId).toBe(SID);
      expect(l.bundle.digest).toBe(digest);
      expect(l.host.instanceId).toBe('i-dev-etest001-lab');
    }
  });

  it('a modified check file is detected before anything runs (RUNNER_INTEGRITY)', async () => {
    const copy = tmpDir('tamper-');
    fs.cpSync(path.join(out, 'atl'), path.join(copy, 'atl'), { recursive: true });
    fs.appendFileSync(path.join(copy, 'atl', 'checks', digest, 'checks', 'env-key.mjs'), '\n// changed\n');
    const r = await run(ssm('env-key', { module: 'cdn', key: 'CDN_ORIGIN_PORT' }), path.join(copy, 'atl', 'bin', 'atl-check.mjs'));
    expect(r.lines[0]!.errorCode).toBe('RUNNER_INTEGRITY');
    expect(r.lines[0]!.message).toContain('checks/env-key.mjs');
    fs.rmSync(copy, { recursive: true, force: true });
  });

  it('the bash launcher applies the same gates (skipped without bash/sha256sum)', async () => {
    const bash = spawnSync('bash', ['-c', 'command -v sha256sum'], { encoding: 'utf8' });
    if (bash.status !== 0) return;
    const env = { ...process.env, ...ssm('env-key', { module: 'cdn', key: 'CDN_ORIGIN_PORT' }), ATL_ROOT_OVERRIDE_FOR_TESTS: path.join(out, 'atl').replace(/\\/g, '/') };
    const ok = spawnSync('bash', [path.join(out, 'atl', 'bin', 'atl-check').replace(/\\/g, '/')], { env, encoding: 'utf8', timeout: 30_000 });
    const line = ok.stdout.split(/\r?\n/).find((l) => l.startsWith('ATL-RESULT-V1 '));
    expect(line, ok.stderr).toBeDefined();
    expect(JSON.parse(Buffer.from(line!.slice(14), 'base64url').toString('utf8')).observed).toEqual({ present: true, value: '8080' });
    const bad = spawnSync('bash', [path.join(out, 'atl', 'bin', 'atl-check').replace(/\\/g, '/')], { env: { ...env, SSM_BundleDigest: 'a'.repeat(64) }, encoding: 'utf8' });
    expect(bad.status).not.toBe(0);
    expect(JSON.parse(Buffer.from(bad.stdout.trim().slice(14), 'base64url').toString('utf8')).errorCode).toBe('RUNNER_INTEGRITY');
  });
});

describe('checks against a local CloudAlbum stand-in (ATL_DEV_MODE)', () => {
  it('http-probe attaches the local probe token on loopback probe paths and parses the path header', async () => {
    const r = await run(ssm('http-probe', { target: 'self', path: '/api/lab/probe/now', method: 'GET', repeat: 2, intervalMs: 10, nonce: 'nonce-12345678' }));
    const o = r.lines[0]!;
    expect(o.status).toBe('ok');
    expect(o.observed.responses).toHaveLength(2);
    expect(o.observed.responses[0].status).toBe(200);
    expect(o.observed.responses[0].json).toEqual({ now: 'T1' });
    expect(o.observed.responses[0].pathSegments.entry).toBe('nginx');
    expect(JSON.stringify(o)).not.toContain('local-secret');
    const hit = seen.filter((s) => s.path.startsWith('/api/lab/probe/now'));
    expect(hit.length).toBeGreaterThanOrEqual(2);
    expect(hit[0]!.headers['x-atl-probe-nonce']).toBe('nonce-12345678');
  });

  it('rejects non-allowlisted request headers and arbitrary hosts for local targets', async () => {
    const r = await run(ssm('http-probe', { target: 'self', path: '/', headers: { 'X-Forwarded-For': '1.2.3.4' } }));
    expect(r.lines[0]!.errorCode).toBe('NOT_ALLOWED');
    const r2 = await run(ssm('http-probe', { target: 'cdn', path: '/' }));
    expect(r2.lines[0]!.errorCode).toBe('TARGET_UNRESOLVED');
  });

  it('capability-snapshot projects modules and validation; caps.profile judges with expected warnings', async () => {
    const r = await run(ssm('atl.capabilities', { view: 'public', modules: ['auth', 'cdn'] }));
    const o = r.lines[0]!;
    expect(o.status).toBe('ok');
    expect(Object.keys(o.observed.modules).sort()).toEqual(['auth', 'cdn']);
    expect(o.observed.validation.warnings[0]).toEqual({ rule: 'DEP-013', modules: ['auth'] });
    const ok = (await run(ssm('caps.profile', { expect: { iam: 'role', auth: 'local' }, expectedWarnings: ['DEP-013'] }))).lines[0]!;
    expect(ok.observed.healthy).toBe(true);
    const bad = (await run(ssm('caps.profile', { expect: { iam: 'role', auth: 'local' }, expectedWarnings: [] }))).lines[0]!;
    expect(bad.observed.healthy).toBe(false);
    expect(bad.observed.diffs[0].module).toBe('auth');
  });
});

describe('nginx-log-summary and result lines', () => {
  it('counts the nonce on every line (probe included) and excludes probe lines from counts', async () => {
    const mod = (await import(pathToFileURL(path.join(CHECKS, 'src', 'checks', 'nginx-log-summary.mjs')).href)) as { summarize: (lines: string[], args: Record<string, unknown>, now: number) => Rec };
    const now = Date.parse('2026-10-13T07:30:00Z');
    const line = (o: Record<string, unknown>) => JSON.stringify({ ts: '2026-10-13T07:25:00+00:00', status: 200, port: '8080', args: '', probe: '0', cf_id: '', ...o });
    const lines = [
      line({ args: 'atlprobe=N1', probe: '1', cf_id: 'CF-A' }),
      line({ args: 'x=1', port: '80' }),
      line({ args: 'atlprobe=N2' }),
      line({ ts: '2026-10-13T06:00:00+00:00', args: 'atlprobe=N1' }),
      'garbage',
    ];
    const s = mod.summarize(lines, { window: '10m', nonce: 'N1', cfIds: ['CF-A', 'CF-B'], groupBy: 'entry' }, now);
    expect(s.nonce.count).toBe(1);
    expect(s.nonce.ports).toEqual([8080]);
    expect(s.counts.total).toBe(2);
    expect(s.cfIds).toEqual([
      { id: 'CF-A', seen: true },
      { id: 'CF-B', seen: false },
    ]);
  });

  it('truncates the largest array to keep a line ≤ 16 KB', async () => {
    const mod = (await import(pathToFileURL(path.join(CHECKS, 'src', 'lib', 'result.mjs')).href)) as { fitResult: (r: Record<string, unknown>) => Rec; MAX_LINE_JSON: number };
    const r = mod.fitResult({ key: 'c1', observed: { samples: Array.from({ length: 2000 }, (_, i) => ({ i, v: 'x'.repeat(20) })) } });
    expect(r.truncated).toBe(true);
    expect(JSON.stringify(r).length).toBeLessThanOrEqual(mod.MAX_LINE_JSON);
  });
});
