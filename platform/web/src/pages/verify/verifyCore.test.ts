import { canonicalJson as sharedCanonical, CERT_ID_RE as SHARED_CERT_ID_RE } from '@atl/shared';
import { describe, expect, it } from 'vitest';
import { canonicalJson, CERT_ID_RE, certLabs, checkReportFile, decodeJws, reportDigest, supportsLocalVerify, verifyCertificate } from './verifyCore';
import { CERT_ID, certPayload, jwksOf, makeKey, revocations, sampleReport, signJws } from './testFixtures';

const subtle = crypto.subtle;

describe('verifyCore: canonicalization and ids', () => {
  it('matches @atl/shared (RFC 8785) and the shared cert id pattern', () => {
    const v = { b: [3, 1.5, 'x', null, true], a: { z: 1, 'é': '中文', y: undefined }, c: -0.000001 };
    expect(canonicalJson(v)).toBe(sharedCanonical(v));
    expect(CERT_ID_RE.source).toBe(SHARED_CERT_ID_RE.source);
  });

  it('report digest drops integrity and hashes the canonical form', async () => {
    const r = sampleReport();
    const d1 = await reportDigest(subtle, r);
    const d2 = await reportDigest(subtle, { ...r, integrity: { digest: 'other' } });
    expect(d1).toBe(d2);
    expect(d1).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(await reportDigest(subtle, { ...r, revision: 3 })).not.toBe(d1);
  });
});

describe('verifyCertificate (04 §10.5, 08 P09-V results)', () => {
  it('valid: signature, key window, origin, revocation list checked', async () => {
    const key = await makeKey();
    const jws = await signJws(key, 'atl-cert+jws', certPayload());
    const rev = await revocations(key, 12, [{ certId: 'ATL-AAAA-BBBB-CCCC-DDDD', revokedAt: '2026-10-21T00:00:00Z', reason: 'superseded' }]);
    const o = await verifyCertificate({ jws, jwks: jwksOf([key]), revocationsJws: rev, subtle });
    expect(o.status).toBe('valid');
    expect(o.revocations).toEqual({ state: 'checked', seq: 12, entry: null });
    expect(o.key?.kid).toBe(key.kid);
    expect(o.payload?.subject?.displayName).toBe('张三');
  });

  it('revoked: the cert id is in the signed list (reason and time kept)', async () => {
    const key = await makeKey();
    const jws = await signJws(key, 'atl-cert+jws', certPayload());
    const rev = await revocations(key, 13, [{ certId: CERT_ID, revokedAt: '2026-10-22T00:00:00Z', reason: 'superseded' }]);
    const o = await verifyCertificate({ jws, jwks: jwksOf([key]), revocationsJws: rev, subtle });
    expect(o.status).toBe('revoked');
    expect(o.revocations.entry).toMatchObject({ reason: 'superseded' });
  });

  it('a tampered payload fails the signature', async () => {
    const key = await makeKey();
    const jws = await signJws(key, 'atl-cert+jws', certPayload());
    const [h, , s] = jws.split('.');
    const forged = `${h}.${(await signJws(key, 'atl-cert+jws', certPayload({ subject: { displayName: '李四' } }))).split('.')[1]}.${s}`;
    const o = await verifyCertificate({ jws: forged, jwks: jwksOf([key]), revocationsJws: null, subtle });
    expect(o.status).toBe('invalid-signature');
  });

  it('a certificate signed by another key with the same kid fails; an unknown kid is “unknown-key”', async () => {
    const key = await makeKey();
    const other = await makeKey();
    const jws = await signJws(other, 'atl-cert+jws', certPayload());
    expect((await verifyCertificate({ jws, jwks: jwksOf([key]), subtle })).status).toBe('invalid-signature');
    const stranger = await signJws({ ...other, kid: 'nope' }, 'atl-cert+jws', certPayload());
    expect((await verifyCertificate({ jws: stranger, jwks: jwksOf([key]), subtle })).status).toBe('unknown-key');
  });

  it('key validity window, origin, format', async () => {
    const old = await makeKey('old', '2025-01-01T00:00:00Z', '2026-06-01T00:00:00Z');
    const jws = await signJws(old, 'atl-cert+jws', certPayload());
    expect((await verifyCertificate({ jws, jwks: jwksOf([old]), subtle })).status).toBe('key-not-valid');

    const key = await makeKey();
    const elsewhere = await signJws(key, 'atl-cert+jws', certPayload({ issuer: { origin: 'https://evil.example' } }));
    expect((await verifyCertificate({ jws: elsewhere, jwks: jwksOf([key]), subtle })).status).toBe('origin-mismatch');
    // jwks 没有 origins 时不比较签发源
    expect((await verifyCertificate({ jws: elsewhere, jwks: jwksOf([key], []), subtle })).status).toBe('valid');

    expect((await verifyCertificate({ jws: 'abc.def', jwks: jwksOf([key]), subtle })).status).toBe('malformed');
    expect((await verifyCertificate({ jws: 'a.b.c', jwks: jwksOf([key]), subtle })).status).toBe('malformed');
    const wrongTyp = await signJws(key, 'atl-revocations+jws', certPayload());
    expect((await verifyCertificate({ jws: wrongTyp, jwks: jwksOf([key]), subtle })).status).toBe('malformed');
    const v2 = await signJws(key, 'atl-cert+jws', certPayload({ v: 2 }));
    expect((await verifyCertificate({ jws: v2, jwks: jwksOf([key]), subtle })).status).toBe('malformed');
    const nature = await signJws(key, 'atl-cert+jws', certPayload({ nature: 'official' }));
    expect((await verifyCertificate({ jws: nature, jwks: jwksOf([key]), subtle })).status).toBe('malformed');
  });

  it('revocation list unavailable or wrongly signed: the signature verdict stands', async () => {
    const key = await makeKey();
    const other = await makeKey('other');
    const jws = await signJws(key, 'atl-cert+jws', certPayload());
    const none = await verifyCertificate({ jws, jwks: jwksOf([key]), revocationsJws: null, subtle });
    expect(none.status).toBe('valid');
    expect(none.revocations.state).toBe('unavailable');
    const forged = await revocations({ ...other, kid: key.kid }, 99, [{ certId: CERT_ID, revokedAt: 'x', reason: 'misissued' }]);
    const bad = await verifyCertificate({ jws, jwks: jwksOf([key]), revocationsJws: forged, subtle });
    expect(bad.status).toBe('valid');
    expect(bad.revocations.state).toBe('invalid');
    const typ = await signJws(key, 'atl-cert+jws', { seq: 1, entries: [] });
    expect((await verifyCertificate({ jws, jwks: jwksOf([key]), revocationsJws: typ, subtle })).revocations.state).toBe('invalid');
  });

  it('supportsLocalVerify', async () => {
    expect(await supportsLocalVerify(null)).toBe(false);
    expect(await supportsLocalVerify({} as SubtleCrypto)).toBe(false);
    expect(await supportsLocalVerify(subtle)).toBe(true);
    const key = await makeKey();
    expect(await supportsLocalVerify(subtle, key.jwk)).toBe(true);
  });

  it('decodeJws rejects non-base64url input', () => {
    expect(() => decodeJws('a+b.c.d')).toThrow();
  });
});

describe('report file check (04 §10.5 step 7)', () => {
  it('consistent / mismatch / invalid / other card', async () => {
    const report = sampleReport('svc-cdn');
    const digest = await reportDigest(subtle, report);
    const payload = certPayload();
    (payload.achievement as { labs: { reportDigest: string | null }[] }).labs[0]!.reportDigest = digest;
    const p = payload as Parameters<typeof checkReportFile>[1];
    expect((await checkReportFile(subtle, p, JSON.stringify(report), 'svc-cdn')).result).toBe('consistent');
    expect((await checkReportFile(subtle, p, JSON.stringify({ ...report, revision: 9 }), 'svc-cdn')).result).toBe('mismatch');
    expect((await checkReportFile(subtle, p, 'not json', 'svc-cdn')).result).toBe('invalid');
    expect((await checkReportFile(subtle, p, JSON.stringify(sampleReport('svc-auth')), 'svc-cdn'))).toMatchObject({ result: 'mismatch', labId: 'svc-auth' });
    expect((await checkReportFile(subtle, p, JSON.stringify(sampleReport('svc-x'))))).toMatchObject({ result: 'no-lab' });
  });

  it('certLabs handles card certificates (evidence.reportDigest)', () => {
    expect(certLabs({ achievement: { labId: 'svc-ec2', labVersion: '1.0.0' }, evidence: { reportDigest: 'sha256:1' } })).toEqual([{ labId: 'svc-ec2', labVersion: '1.0.0', reportDigest: 'sha256:1' }]);
    expect(certLabs(null)).toEqual([]);
  });
});
