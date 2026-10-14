/**
 * Certificates (04 §10): RFC 8785 payloads signed as JWS ES256 through the SignerPort (dev: local P-256, production:
 * KMS DIGEST), verification round trip (server WebCrypto, the static verify page core and the offline Node tool),
 * tampering, unknown keys, revocation lists, supersession, eligibility, public routes of atl-public.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { bytesToBase64Url, canonicalJson, isCertId, WebKeys, type PlatformPorts } from '@atl/shared';
import { Gsi1, Keys } from '../src/data/keys.js';
import { LocalEcdsaSigner } from '../src/dev/adapters/signer.js';
import { createCertsHandler } from '../src/functions/certs/handler.js';
import { createPublicHandler, setPublicStore } from '../src/functions/public/handler.js';
import type { FunctionDeps } from '../src/runtime/deps.js';
import { loadPlatformEnv } from '../src/runtime/env.js';
import { CERT_TYP, decodeJws, verifySignature, type PublicJwk } from '../src/services/certificates/jws.js';
import { CertError, issueCertificate, latestRevocationList, listSigningKeys, publishRevocations, revokeCertificate, type CertContext, type CertificateItem } from '../src/services/certificates/service.js';
import { VERIFY_CORE_JS } from '../src/services/certificates/verify-core.js';
import { setVerifyPageAssets, verifyPageHtml, verifyPageJs } from '../src/services/certificates/static-site.js';
import { MemoryItemStore, MemoryObjects, RecordingEvents, TestClock } from './checks-support/memory.js';
import { httpEvent, NO_DB, tmpDir } from './helpers.js';

const SUB = 'u-cert-1';
const CV = '2026.10.0';
const TRACK = {
  schema: 'atl.track/v2',
  id: 'quick-compare',
  version: '1.0.0',
  title: '点名对比快速路径',
  stages: [{ id: 's1', title: 'compare', items: [{ card: 'svc-storage', role: 'required' }, { card: 'svc-cdn', role: 'required' }, { card: 'svc-ec2', role: 'optional' }, { group: 'g', title: '综合', pick: 1, cards: ['sc-a', 'sc-b'] }] }],
  completion: { allowManual: true, minAutoRatio: 0.6, excludeSelfReported: true },
  certificate: { enabled: true, title: '七项点名对比证书' },
};

type Verify = (input: { jws: string; jwks: unknown; revocationsJws?: string | null; reports?: unknown[] }) => Promise<{ status: string; revocation?: { reason: string }; reports?: { consistent: boolean }[] }>;
let atlVerify: Verify;
let atlReportDigest: (r: unknown) => Promise<string>;
let store: MemoryItemStore;
let objects: MemoryObjects;
let c: CertContext;
let deps: FunctionDeps;
const keyDir = tmpDir('certkeys-');

const sidFor = (lab: string) => `s${lab.replace(/[^a-z]/g, '').padEnd(12, 'a').slice(0, 12)}`.replace(/[ilou]/g, 'a');

function seedProgress(lab: string, level: 'verified' | 'attested' | 'self-reported', status: 'valid' | 'pending' = 'valid') {
  const sid = sidFor(lab);
  store.seed({ ...Keys.labProgress(SUB, lab), type: 'LabProgress', sub: SUB, labId: lab, kind: lab.startsWith('svc-') ? 'service' : 'scenario', status: 'completed', bestAttemptId: sid, attempts: 1, attemptIds: [sid], firstCompletedAt: '2026-10-13T08:00:00Z', badge: { level, status, earnedAt: '2026-10-13T08:00:00Z', attemptId: sid, labVersion: '1.0.0', variant: 'default', evidenceScore: level === 'verified' ? 1 : 0.85 }, credits: [], regressions: [], quizByService: {} });
  store.seed({ ...Keys.labAttempt(sid), type: 'LabAttempt', sessionId: sid, sub: SUB, labId: lab, status: 'completed', labVersion: '1.0.0', catalogVersion: CV, contentDigest: 'sha256:c', variant: 'default', variables: {}, ownershipPending: [], completedAt: '2026-10-13T08:00:00Z', checksSummary: { auto: 5, manual: 0, failed: 0 } });
  store.seed({ ...Keys.report(sid, 1), type: 'Report', sessionId: sid, version: 1, digest: `sha256:${lab}` });
}

beforeEach(async () => {
  if (!atlVerify) {
    const mod = (await import(`data:text/javascript;base64,${Buffer.from(`${VERIFY_CORE_JS}\nexport { atlVerify, atlReportDigest };`).toString('base64')}`)) as { atlVerify: Verify; atlReportDigest: (r: unknown) => Promise<string> };
    atlVerify = mod.atlVerify;
    atlReportDigest = mod.atlReportDigest;
  }
  store = new MemoryItemStore();
  objects = new MemoryObjects();
  const ports = { clock: new TestClock(), signer: new LocalEcdsaSigner(keyDir), objects, events: new RecordingEvents() } as unknown as PlatformPorts;
  deps = { ports, db: NO_DB, env: { ...loadPlatformEnv({ AWS_REGION: 'ap-northeast-1' }), signingKeyId: 'cert-key-1' } };
  c = { deps, store, nowIso: new Date().toISOString(), invalidate: async () => undefined };
  store.seed({ ...Keys.platformConfig(), type: 'PlatformConfig', installationId: '3f6c1e2a-0000-4000-8000-000000000000', platformUrl: 'https://d1abcdefg.cloudfront.net', region: 'ap-northeast-1' });
  store.seed({ ...Keys.catalogCurrent(), catalogVersion: CV });
  store.seed({ ...Keys.catalogRelease(CV), type: 'CatalogRelease', catalogVersion: CV, contentDigest: 'sha256:release' });
  store.seed({ ...Keys.userProfile(SUB), type: 'Learner', displayName: '张三' });
  await objects.put(deps.env.buckets.web, `${WebKeys.content(CV)}tracks/quick-compare.json`, JSON.stringify(TRACK));
  for (const lab of ['svc-storage', 'svc-cdn', 'sc-a']) seedProgress(lab, 'verified');
});

function jwksOf(): Record<string, unknown> {
  return JSON.parse(objects.text(deps.env.buckets.web, WebKeys.jwks)!) as Record<string, unknown>;
}

describe('JWS ES256 over RFC 8785 (04 §10.3, §10.4)', () => {
  it('signs a track certificate, publishes JWKS and verifies with WebCrypto, the verify page core and the offline tool', async () => {
    const { certificate: cert } = await issueCertificate(c, { sub: SUB, scope: 'track', trackId: 'quick-compare' });
    expect(isCertId(cert.certId)).toBe(true);
    const d = decodeJws(cert.jws);
    expect(d.header).toMatchObject({ alg: 'ES256', typ: CERT_TYP, kid: cert.kid });
    expect(new TextDecoder().decode(d.payloadBytes)).toBe(canonicalJson(d.payload));
    expect(d.payload).toMatchObject({ v: 1, kind: 'track', nature: 'self-hosted-self-signed', subject: { displayName: '张三' } });
    const ach = d.payload.achievement as { labs: { labId: string; reportDigest: string; attemptRef: string }[]; verifiedRatio: number };
    expect(ach.labs.map((l) => l.labId).sort()).toEqual(['sc-a', 'svc-cdn', 'svc-storage']);
    expect(ach.labs[0]!.attemptRef).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(JSON.stringify(d.payload)).not.toContain(SUB);
    const [key] = await listSigningKeys(store);
    expect(key!.kid).toBe(cert.kid);
    expect(await verifySignature(d, key!.jwk as PublicJwk)).toBe(true);
    const jwks = jwksOf();
    expect((jwks.keys as { kid: string }[])[0]!.kid).toBe(cert.kid);
    expect(jwks.origins).toEqual(['https://d1abcdefg.cloudfront.net']);
    expect((await atlVerify({ jws: cert.jws, jwks })).status).toBe('valid');
    // offline tool: node verify.mjs bundle.json
    const handler = createCertsHandler(async () => deps, undefined, { store: () => store, invalidator: () => async () => undefined });
    const bundle = (await handler({ action: 'OfflineBundle', certId: cert.certId, sub: SUB })) as { verifyScript: string };
    const dir = tmpDir('offline-');
    fs.writeFileSync(path.join(dir, 'verify.mjs'), bundle.verifyScript);
    fs.writeFileSync(path.join(dir, 'cert.json'), JSON.stringify(bundle));
    const r = spawnSync(process.execPath, [path.join(dir, 'verify.mjs'), path.join(dir, 'cert.json')], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout).status).toBe('valid');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('detects tampering, unknown keys, wrong token types and keys outside their validity', async () => {
    const { certificate: cert } = await issueCertificate(c, { sub: SUB, scope: 'track', trackId: 'quick-compare' });
    const jwks = jwksOf();
    const [h, , s] = cert.jws.split('.');
    const forged = { ...decodeJws(cert.jws).payload, subject: { displayName: 'Mallory', ref: 'x' } };
    const tampered = `${h}.${bytesToBase64Url(new TextEncoder().encode(canonicalJson(forged)))}.${s}`;
    expect((await atlVerify({ jws: tampered, jwks })).status).toBe('invalid-signature');
    expect((await atlVerify({ jws: cert.jws, jwks: { keys: [] } })).status).toBe('unknown-key');
    const k = (jwks.keys as Record<string, unknown>[])[0]!;
    expect((await atlVerify({ jws: cert.jws, jwks: { ...jwks, keys: [{ ...k, 'atl:validTo': '2020-01-01T00:00:00Z' }] } })).status).toBe('key-not-valid');
    const rev = await publishRevocations(c, []);
    expect((await atlVerify({ jws: rev.jws, jwks })).status).toBe('wrong-type');
  });

  it('revocation list: signed, sequenced, published, and honoured by every verifier', async () => {
    const { certificate: cert } = await issueCertificate(c, { sub: SUB, scope: 'track', trackId: 'quick-compare' });
    const r = await revokeCertificate(c, cert.certId, 'learner-request', SUB);
    expect(r.certificate.status).toBe('revoked');
    const list = (await latestRevocationList(store))!;
    expect(list.entries).toEqual([{ certId: cert.certId, revokedAt: c.nowIso, reason: 'learner-request' }]);
    const published = objects.text(deps.env.buckets.web, WebKeys.revocations)!.trim();
    expect(published).toBe(list.jws);
    expect(decodeJws(published).header.typ).toBe('atl-revocations+jws');
    const v = await atlVerify({ jws: cert.jws, jwks: jwksOf(), revocationsJws: published });
    expect(v.status).toBe('revoked');
    expect(v.revocation?.reason).toBe('learner-request');
    // revocation of an unknown certificate / foreign holder is refused
    await expect(revokeCertificate(c, 'ATL-0000-0000-0000-0000', 'learner-request', SUB)).rejects.toBeInstanceOf(CertError);
    // sequence numbers keep growing
    const again = await publishRevocations(c, []);
    expect(again.seq).toBe(list.seq + 1);
  });

  it('re-claiming supersedes the previous certificate; ineligible paths are refused with reasons', async () => {
    const first = (await issueCertificate(c, { sub: SUB, scope: 'track', trackId: 'quick-compare' })).certificate;
    const second = (await issueCertificate(c, { sub: SUB, scope: 'track', trackId: 'quick-compare', public: true })).certificate;
    expect((await store.get<CertificateItem>(Keys.certificate(first.certId)))!.revokeReason).toBe('superseded');
    expect(objects.text(deps.env.buckets.web, WebKeys.publicCert(second.certId))!.trim()).toBe(second.jws);
    seedProgress('svc-cdn', 'self-reported');
    const e = await issueCertificate(c, { sub: SUB, scope: 'track', trackId: 'quick-compare' }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(CertError);
    expect((e as CertError).code).toBe('CERT_NOT_ELIGIBLE');
    expect((e as CertError).reasons.join()).toContain('svc-cdn');
  });

  it('report digests in the verify core match the server canonical form', async () => {
    const report = { schema: 'atl.report/v1', lab: { id: 'svc-cdn' }, z: 1, a: [1, { b: 'ü' }] };
    const { reportDigest } = await import('../src/services/reports/report.js');
    expect(await atlReportDigest(report)).toBe(reportDigest(report as never));
  });

  it('the static verify page loads no third-party code and states the disclaimer', () => {
    const html = verifyPageHtml();
    expect(html).toContain('<script src="/verify/verify.js"></script>');
    expect(html).not.toMatch(/<script>[^<]/);
    expect(html).not.toMatch(/https?:\/\/(?!docs)/);
    expect(html).toContain('不是 AWS 官方认证');
  });
});

describe('verify page assets (P09-V or the fallback page)', () => {
  it('publishes the P09-V build when it is embedded / set, else the fallback page; ensureVerification republishes on change', async () => {
    const { publishVerifyPage } = await import('../src/services/certificates/service.js');
    const c = { deps, store, nowIso: new Date().toISOString(), invalidate: async () => undefined } as unknown as CertContext;
    setVerifyPageAssets(null);
    await publishVerifyPage(c);
    expect(objects.text(deps.env.buckets.web, 'verify/verify.js')).toBe(verifyPageJs());
    setVerifyPageAssets({ 'index.html': '<!doctype html><title>P09-V</title>', 'verify.js': '/* p09-v */', 'verify.css': 'body{}' });
    try {
      await publishVerifyPage(c);
      expect(objects.text(deps.env.buckets.web, 'verify/index.html')).toContain('P09-V');
      expect(objects.text(deps.env.buckets.web, 'verify/verify.js')).toBe('/* p09-v */');
      expect(objects.text(deps.env.buckets.web, 'verify/verify.css')).toBe('body{}');
    } finally {
      setVerifyPageAssets(null);
    }
  });
});

describe('atl-certs actions (synchronous contract with atl-api)', () => {
  it('IssueCertificate returns certId, jws and payload; ineligible requests throw Atl.CERT_NOT_ELIGIBLE with reasons', async () => {
    const handler = createCertsHandler(async () => deps, undefined, { store: () => store, invalidator: () => async () => undefined });
    const ok = (await handler({ action: 'IssueCertificate', sub: SUB, scope: 'track', trackId: 'quick-compare' })) as { certId: string; jws: string; payload: { certId: string } };
    expect(ok.payload.certId).toBe(ok.certId);
    await expect(handler({ action: 'IssueCertificate', sub: 'nobody', scope: 'track', trackId: 'quick-compare' })).rejects.toMatchObject({ name: 'Atl.CERT_NOT_ELIGIBLE' });
    const rev = (await handler({ action: 'RevokeCertificate', certId: ok.certId, reason: 'learner-request', sub: SUB })) as { status: string; revocationsSeq: number };
    // seq 1 is the empty signed list published with the verify page when the first certificate was issued
    expect(rev).toMatchObject({ status: 'revoked', revocationsSeq: 2 });
    await expect(handler({ action: 'Nope' })).rejects.toThrow(/not implemented/);
  });
});

describe('atl-public routes', () => {
  it('returns certificate status and public keys only', async () => {
    const { certificate: cert } = await issueCertificate(c, { sub: SUB, scope: 'track', trackId: 'quick-compare' });
    setPublicStore(() => store);
    const h = createPublicHandler(async () => deps);
    const r = await h(httpEvent('GET', `/api/v1/public/certificates/${cert.certId}`));
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body!) as Record<string, unknown>;
    expect(body.status).toBe('valid');
    expect(body.jws).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain(SUB);
    const keys = JSON.parse((await h(httpEvent('GET', '/api/v1/public/keys'))).body!) as { keys: { kid: string; publicKeyPem: string }[] };
    expect(keys.keys[0]!.kid).toBe(cert.kid);
    expect(keys.keys[0]!.publicKeyPem).toContain('BEGIN PUBLIC KEY');
    expect((await h(httpEvent('GET', `/api/v1/public/keys/${cert.kid}`))).statusCode).toBe(200);
    expect((await h(httpEvent('GET', '/api/v1/public/certificates/not-a-cert'))).statusCode).toBe(404);
    expect(Gsi1.signingKey('x').GSI1PK).toBe('KEYS');
  });
});
