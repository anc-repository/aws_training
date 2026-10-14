// wave1-waf: experiments/waf manifest and Node scenarios. The manifest matches the registry; the pure helpers (targets, nonce,
// waf segment) are unit-tested; the four scenarios run end-to-end against a small front server (attack endpoints + the admin
// /api/lab/waf/origin evidence endpoint; the rest is forwarded to the shared mock server). No real AWS, no shell, no flooding.
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { REGISTRY_DOCUMENT } from '@cloudalbum/contracts/registry';
import type { CapabilitiesResponse } from '@cloudalbum/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeSharedDispatcher } from '../_lib/http.js';
import { loadManifest, validateLabel } from '../_lib/manifest.js';
import { EXIT, parseRunnerArgs, runExperiment } from '../_lib/runner.js';
import { validateResult } from '../_lib/schema.js';
import type { ResultDoc } from '../_lib/types.js';
import { experimentsRoot } from '../_lib/util.js';
import { runNonce, wafSegment, wafTargets, withNonce } from '../waf/lib.js';
import { startMockServer, type MockServer } from './mock-server.js';

let mock: MockServer;
let front: http.Server;
let frontUrl = '';
let login = 0;
/** wave1-integration: when set, the front patches capabilities (cdn directAccess=admin-ip, adminCidr) and echoes 127.0.0.1 */
let adminCidr: string | undefined;
const tmp = mkdtempSync(path.join(os.tmpdir(), 'exp-waf-'));

function json(res: http.ServerResponse, status: number, body: unknown, waf?: string): void {
  const headers: Record<string, string> = { 'content-type': 'application/json', 'server-timing': 'total;dur=2' };
  if (waf) headers['x-cloudalbum-path'] = `entry=cloudfront>waf>nginx;${waf}`;
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
}

function forward(req: http.IncomingMessage, body: Buffer, res: http.ServerResponse, patch?: (text: string) => string): void {
  const t = new URL(mock.url);
  const up = http.request({ host: t.hostname, port: t.port, path: req.url, method: req.method, headers: req.headers }, (r) => {
    const chunks: Buffer[] = [];
    r.on('data', (c: Buffer) => chunks.push(c));
    r.on('end', () => {
      const h = { ...r.headers };
      delete h['content-length'];
      res.writeHead(r.statusCode ?? 502, h);
      const text = Buffer.concat(chunks);
      res.end(patch ? patch(text.toString('utf8')) : text);
    });
  });
  up.on('error', () => json(res, 502, { error: 'BAD_GATEWAY' }));
  up.end(body);
}

beforeAll(async () => {
  mock = await startMockServer({ drivers: { cdn: 'cloudfront', waf: 'aws' }, statuses: { waf: 'ok' } });
  front = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const u = new URL(req.url ?? '/', 'http://front');
      const p = u.pathname;
      const m = req.method ?? 'GET';
      if (p === '/api/auth/login' && m === 'POST') {
        // simulate a rate rule: every 3rd request is blocked (so flood sees blocks and a first-block time)
        login += 1;
        return login % 3 === 0 ? json(res, 429, { error: 'RATE_LIMITED' }, 'waf=aws:block-rate-login') : json(res, 401, { error: 'INVALID_CREDENTIALS' });
      }
      if (p.startsWith('/api/public/') && m === 'GET') {
        // the payloads scenario encodes attack strings into the query; block the ones AWS WAF would catch
        const q = decodeURIComponent(u.search);
        const blocked = /UnIoN|union\s+select|script|jndi|sqlmap|passwd/i.test(q) || String(req.headers['user-agent'] ?? '').includes('sqlmap') || String(req.headers['x-api-version'] ?? '').includes('jndi');
        return blocked ? json(res, 403, { error: 'FORBIDDEN' }, 'waf=aws:block-crs') : json(res, 200, { now: new Date().toISOString() });
      }
      if (p === '/api/lab/echo' && m === 'GET') return json(res, 200, { ip: '127.0.0.1', host: req.headers.host ?? null, entry: 'direct' });
      if (p === '/api/capabilities' && m === 'GET' && adminCidr) {
        const cidr = adminCidr;
        return forward(req, body, res, (text) => {
          const doc = JSON.parse(text) as { modules: Record<string, { data?: Record<string, unknown> }> };
          doc.modules.cdn = { ...doc.modules.cdn, data: { ...(doc.modules.cdn?.data ?? {}), directAccess: 'admin-ip', adminCidr: cidr } };
          return JSON.stringify(doc);
        });
      }
      if (p === '/api/lab/waf/origin' && m === 'GET') {
        const nonce = u.searchParams.get('nonce') ?? '';
        return json(res, 200, { mode: 'aws', logPresent: true, requests: 4, byStatus: { 200: 4 }, byPort: { 8080: 4 }, viaCloudfront: 4, direct: 0, nonce: { value: nonce, count: 4, ports: [8080] } });
      }
      forward(req, body, res);
    });
  });
  await new Promise<void>((r) => front.listen(0, '127.0.0.1', r));
  frontUrl = `http://127.0.0.1:${(front.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => front.close(() => r()));
  await mock.close();
  await closeSharedDispatcher();
  rmSync(tmp, { recursive: true, force: true });
});

async function run(id: string, label: string, extra: string[] = []): Promise<ResultDoc> {
  const argv = [
    'waf', '--scenario', id, '--label', label, '--vus', '1', '--duration', '400ms', '--warmup', '0s', '--force', '--target', frontUrl,
    '--out', path.join(tmp, 'results'), '--param', `direct=${frontUrl}`, ...extra,
  ];
  const lines: string[] = [];
  const r = await runExperiment(parseRunnerArgs(argv), {
    env: { CLOUDALBUM_ADMIN_TOKEN: mock.adminToken }, repo: tmp, log: (l) => lines.push(l),
  });
  expect(r.code, `${r.message ?? ''}\n${lines.join('\n')}`).toBe(EXIT.ok);
  const doc = r.result as ResultDoc;
  expect(validateResult(doc).errors).toEqual([]);
  return doc;
}

describe('waf manifest', () => {
  it('schema-valid, ids = registry lab.experiments, labels / params consistent', () => {
    const manifest = loadManifest('waf', experimentsRoot());
    const registryIds = REGISTRY_DOCUMENT.modules.waf.lab.experiments ?? [];
    expect(manifest.experiments.map((e) => e.id).sort()).toEqual([...registryIds].sort());
    for (const e of manifest.experiments) {
      for (const label of Object.keys(e.requires ?? {})) expect(() => validateLabel(e, label)).not.toThrow();
      for (const [k, spec] of Object.entries(e.params ?? {})) expect(spec.default, `${e.id}.params.${k}.default`).toBeDefined();
    }
  });
});

function caps(p: { cdnPublic?: Record<string, unknown>; cdnData?: Record<string, unknown>; entry?: { baseUrl: string; source: string } }): CapabilitiesResponse {
  return {
    app: { entry: p.entry ?? { baseUrl: 'http://203.0.113.10', source: 'base' } },
    modules: { cdn: { public: p.cdnPublic, data: p.cdnData } },
  } as unknown as CapabilitiesResponse;
}

describe('waf/lib', () => {
  it('wafTargets: --param > capabilities > runner target; edge only when it differs from direct', () => {
    const c = caps({ cdnPublic: { baseUrl: 'https://d111.cloudfront.net' }, cdnData: { originDirectUrl: 'http://ec2-203-0-113-10.compute.amazonaws.com' } });
    expect(wafTargets({ params: {}, capabilities: c, target: 'http://203.0.113.10' })).toEqual({ direct: 'http://ec2-203-0-113-10.compute.amazonaws.com', edge: 'https://d111.cloudfront.net' });
    expect(wafTargets({ params: { direct: 'http://1.2.3.4', edge: 'https://e.cloudfront.net' }, capabilities: caps({}), target: '' })).toEqual({ direct: 'http://1.2.3.4', edge: 'https://e.cloudfront.net' });
    expect(wafTargets({ params: {}, capabilities: caps({}), target: 'http://203.0.113.10' })).toEqual({ direct: 'http://203.0.113.10' });
  });

  it('withNonce / runNonce / wafSegment', () => {
    expect(withNonce('/api/public/now', 'waf-01JABC')).toBe('/api/public/now?atlprobe=waf-01JABC');
    expect(withNonce('/api/public/now?q=1', 'n12345678')).toBe('/api/public/now?q=1&atlprobe=n12345678');
    expect(runNonce({ runId: '01JA0000000000000000000000' })).toMatch(/^waf-[0-9A-Z]{26}$/);
    expect(wafSegment({ headers: { 'x-cloudalbum-path': 'entry=cloudfront>waf>nginx;waf=aws:block-rate-login' } })).toBe('aws:block-rate-login');
    expect(wafSegment({ headers: {} })).toBeUndefined();
  });
});

describe('waf scenarios', () => {
  it('flood: records status codes, a block ratio and first-block time, and the origin nonce count (server evidence)', async () => {
    const d = await run('flood', 'after', ['--param', 'target=direct', '--param', 'rate=50', '--param', 'duration=5']);
    const direct = d.scenario!.findings.direct as { sent: number; blocked: number; blockRatio: number; byStatus: Record<string, number> };
    expect(direct.sent).toBeGreaterThan(0);
    expect(direct.blocked).toBeGreaterThan(0);
    expect(direct.byStatus['429']).toBeGreaterThan(0);
    expect((d.scenario!.findings.origin as { nonceCount: number }).nonceCount).toBe(4);
  }, 30_000);

  it('payloads: encoded SQLi / traversal / scanner-UA variants are blocked (403), the plain-safe probe is 200', async () => {
    const d = await run('payloads', 'after', ['--param', 'target=direct']);
    const row = (d.scenario!.findings.direct as { byPayload: Record<string, { status: number; blocked: boolean }> }).byPayload;
    expect(row['sqli-url']!.blocked).toBe(true);
    expect(row['scanner-ua']!.blocked).toBe(true);
    expect(d.scenario!.findings.payloadIds).toEqual(expect.arrayContaining(['sqli-double', 'log4shell-header']));
  }, 30_000);

  it('false-positive: the large body is allowed; the finding carries the rule action and both probe statuses', async () => {
    const d = await run('false-positive', 'after');
    const large = d.scenario!.findings.largeBody as { status: number; blocked: boolean };
    expect(large.blocked).toBe(false);
    expect(d.scenario!.findings.sqlKeywordText).toBeDefined();
  }, 30_000);

  it('bypass: the direct origin is reachable on the front => origin not locked (before)', async () => {
    const d = await run('bypass', 'before');
    expect(d.scenario!.findings.direct).toMatchObject({ reachable: true });
    expect(d.scenario!.findings.originLocked).toBe(false);
  }, 30_000);

  it('bypass after admin-ip: reachable only because the origin sees the runner inside CDN_ADMIN_CIDR => locked (server evidence)', async () => {
    try {
      adminCidr = '127.0.0.1/32';
      const inside = await run('bypass', 'after');
      expect(inside.scenario!.findings).toMatchObject({ directAccess: 'admin-ip', originSeenClientIp: '127.0.0.1', directAllowedAsAdmin: true, originLocked: true });
      adminCidr = '198.51.100.7/32';
      const outside = await run('bypass', 'after');
      expect(outside.scenario!.findings).toMatchObject({ directAllowedAsAdmin: false, originLocked: false });
    } finally {
      adminCidr = undefined;
    }
  }, 60_000);
});

describe('waf/lib ipv4InCidr', () => {
  it('matches IPv4 (and IPv4-mapped IPv6) against a CIDR; anything unparsable is false', async () => {
    const { ipv4InCidr } = await import('../waf/lib.js');
    expect(ipv4InCidr('203.0.113.10', '203.0.113.10/32')).toBe(true);
    expect(ipv4InCidr('203.0.113.77', '203.0.113.0/24')).toBe(true);
    expect(ipv4InCidr('::ffff:203.0.113.77', '203.0.113.0/24')).toBe(true);
    expect(ipv4InCidr('203.0.114.1', '203.0.113.0/24')).toBe(false);
    expect(ipv4InCidr('2001:db8::1', '203.0.113.0/24')).toBe(false);
    expect(ipv4InCidr('203.0.113.10', 'nonsense')).toBe(false);
  });
});
