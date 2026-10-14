// dns / tls 实验（wave1-route53-acm）：清单与 registry 一致、脚本存在、纯函数（换 IP 演练分析、加权比例、nmap 解析、证书分类、入口推断）。
// 场景本身需要真实域名与 AWS 资源，不在单元测试里跑；网络部分只测“连不上时不抛异常”。
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { CapabilitiesResponse } from '@cloudalbum/contracts';
import { REGISTRY_DOCUMENT } from '@cloudalbum/contracts/registry';
import { describe, expect, it } from 'vitest';
import { loadManifest, validateLabel } from '../_lib/manifest.js';
import { validateExperimentManifest } from '../_lib/schema.js';
import { experimentsRoot } from '../_lib/util.js';
import { analyzeIpChange, answerShares, domainOf, eipOf } from '../dns/lib.js';
import { certKind, inspectEntry, parseSslEnumCiphers, tlsEntries, type CertInfo } from '../tls/lib.js';

const root = experimentsRoot();

describe.each(['dns', 'tls'] as const)('%s experiment manifest', (module) => {
  const manifest = loadManifest(module, root);
  it('validates against the schema and covers exactly the registry experiments', async () => {
    const { readFileSync } = await import('node:fs');
    const raw = JSON.parse(readFileSync(path.join(root, module, 'experiment.json'), 'utf8')) as unknown;
    expect(validateExperimentManifest(raw)).toEqual({ ok: true, errors: [] });
    const ids = REGISTRY_DOCUMENT.modules[module].lab.experiments ?? [];
    expect(manifest.experiments.map((e) => e.id).sort()).toEqual([...ids].sort());
  });

  it('scripts, fault scripts and labels exist', async () => {
    for (const e of manifest.experiments) {
      const file = path.join(root, module, e.scenario.script!);
      expect(existsSync(file), file).toBe(true);
      const mod = (await import(pathToFileURL(file).href)) as { default?: { run?: unknown } };
      expect(typeof mod.default?.run).toBe('function');
      for (const f of e.faults ?? []) {
        expect(existsSync(path.join(root, module, f.script!)), f.script).toBe(true);
        for (const l of f.onlyFor ?? []) expect(Object.keys(e.requires ?? {})).toContain(l);
      }
      for (const label of Object.keys(e.requires ?? {})) expect(() => validateLabel(e, label)).not.toThrow();
      for (const [k, spec] of Object.entries(e.params ?? {})) expect(spec.default, `${e.id}.${k}`).toBeDefined();
    }
  });
});

function caps(p: { dns?: Record<string, unknown>; tls?: Record<string, unknown>; ec2?: Record<string, unknown>; cdnBase?: string; entry?: { baseUrl: string; source: string } }): CapabilitiesResponse {
  return {
    app: { entry: p.entry ?? { baseUrl: 'http://203.0.113.10', source: 'base' } },
    modules: {
      dns: { data: p.dns }, tls: { data: p.tls }, ec2: { data: p.ec2 }, cdn: { public: p.cdnBase ? { baseUrl: p.cdnBase } : {} },
    },
  } as unknown as CapabilitiesResponse;
}

describe('dns/lib', () => {
  it('domain and EIP come from --param, then capabilities, then the runner target', () => {
    const c = caps({ dns: { recordName: 'album.example.com' }, ec2: { publicIpv4: '203.0.113.10' } });
    expect(domainOf({ params: {}, capabilities: c, target: 'http://203.0.113.10' })).toBe('album.example.com');
    expect(domainOf({ params: { domain: 'Other.Example.com' }, capabilities: c, target: '' })).toBe('other.example.com');
    expect(domainOf({ params: {}, capabilities: caps({}), target: 'http://203.0.113.10' })).toBe('');
    expect(eipOf({ params: {}, capabilities: c, target: 'http://album.example.com' })).toBe('203.0.113.10');
    expect(eipOf({ params: {}, capabilities: caps({}), target: 'http://198.51.100.1' })).toBe('198.51.100.1');
  });

  it('analyzeIpChange: old IP link keeps failing, the domain recovers once the resolver returns the new IP', () => {
    const a = analyzeIpChange([
      { t: 0, oldLinkOk: true, domainOk: true, answers: ['203.0.113.10'] },
      { t: 5, oldLinkOk: false, domainOk: false, answers: ['203.0.113.10'], newIp: '198.51.100.7' },
      { t: 10, oldLinkOk: false, domainOk: false, answers: ['203.0.113.10'], newIp: '198.51.100.7' },
      { t: 70, oldLinkOk: false, domainOk: true, answers: ['198.51.100.7'], newIp: '198.51.100.7' },
    ]);
    expect(a).toMatchObject({ samples: 4, oldLinkFailures: 3, domainFailures: 2, swapAt: 5, resolverSwitchSec: 65, domainRecoverySec: 65, domainNeverRecovered: false });
    const before = analyzeIpChange([
      { t: 0, oldLinkOk: true }, { t: 5, oldLinkOk: false, newIp: '198.51.100.7' }, { t: 10, oldLinkOk: false, newIp: '198.51.100.7' },
    ]);
    expect(before).toMatchObject({ oldLinkFailures: 2, domainFailures: 0, domainNeverRecovered: false });
    expect(before.domainRecoverySec).toBeUndefined();
  });

  it('answerShares: proportion of each answer set', () => {
    expect(answerShares([['203.0.113.10'], ['203.0.113.10'], ['203.0.113.10'], ['198.51.100.7']])).toEqual({ '203.0.113.10': 0.75, '198.51.100.7': 0.25 });
    expect(answerShares([[]])).toEqual({ '(empty)': 1 });
  });
});

describe('tls/lib', () => {
  it('entries: direct EIP with SNI = TLS domain, CDN, https entry URL', () => {
    const c = caps({ tls: { domain: 'album.example.com' }, ec2: { publicIpv4: '203.0.113.10' }, cdnBase: 'https://d111.cloudfront.net',
      entry: { baseUrl: 'https://album.example.com', source: 'dns' } });
    expect(tlsEntries({ params: {}, capabilities: c, target: 'http://203.0.113.10' })).toEqual([
      { entry: 'direct', host: '203.0.113.10', port: 443, servername: 'album.example.com' },
      { entry: 'cdn', host: 'd111.cloudfront.net', port: 443, servername: 'd111.cloudfront.net' },
      { entry: 'entry', host: 'album.example.com', port: 443, servername: 'album.example.com' },
    ]);
    expect(tlsEntries({ params: { hosts: 'direct=203.0.113.10,cdn=d1.cloudfront.net' }, capabilities: caps({}), target: '' }).map((e) => e.entry)).toEqual(['direct', 'cdn']);
  });

  it('certKind: self-signed, Let\'s Encrypt, Amazon, CloudFront default', () => {
    const base: CertInfo = { entry: 'direct', host: 'x', ok: true };
    expect(certKind({ ...base, issuer: 'cloudalbum-l0', subject: 'cloudalbum-l0', trusted: false })).toBe('selfsigned');
    expect(certKind({ ...base, issuer: "Let's Encrypt", trusted: true })).toBe('letsencrypt');
    expect(certKind({ ...base, issuer: 'Amazon', trusted: true })).toBe('amazon');
    expect(certKind({ ...base, issuer: 'Amazon', sans: ['cloudfront.net', '*.cloudfront.net'], trusted: true })).toBe('cf-default');
    expect(certKind({ ...base, ok: false })).toBe('unknown');
  });

  it('parseSslEnumCiphers: protocols, ciphers per protocol, least strength', () => {
    const out = [
      'PORT    STATE SERVICE', '443/tcp open  https', '| ssl-enum-ciphers: ', '|   TLSv1.2: ', '|     ciphers: ',
      '|       TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256 (secp256r1) - A', '|       TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384 (secp256r1) - A',
      '|     compressors: ', '|       NULL', '|     cipher preference: server', '|   TLSv1.3: ', '|     ciphers: ',
      '|       TLS_AKE_WITH_AES_128_GCM_SHA256 (ecdh_x25519) - A', '|     cipher preference: server', '|_  least strength: A',
    ].join('\n');
    expect(parseSslEnumCiphers(out)).toEqual({
      protocols: ['TLSv1.2', 'TLSv1.3'],
      ciphers: { 'TLSv1.2': ['TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256', 'TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384'], 'TLSv1.3': ['TLS_AKE_WITH_AES_128_GCM_SHA256'] },
      leastStrength: 'A',
    });
  });

  it('inspectEntry: a peer that is not TLS gives ok=false instead of throwing', async () => {
    const srv = createServer((s) => s.end('plain\n'));
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const port = (srv.address() as { port: number }).port;
    const c = await inspectEntry({ entry: 'direct', host: '127.0.0.1', port }, 2000);
    srv.close();
    expect(c.ok).toBe(false);
  });
});
