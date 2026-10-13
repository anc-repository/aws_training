/**
 * 测试用的证书夹具：用 WebCrypto 生成 P-256 密钥，按 atl-certs 的方式（04 §10.3：header JSON、RFC 8785 载荷、r‖s 签名）
 * 签出证书与吊销列表。只被测试引用。
 */
import { bytesToBase64Url, canonicalJsonBytes } from '@atl/shared';
import type { Jwks, PublicJwk } from './verifyCore';

export const ORIGIN = 'https://d1234abcd.cloudfront.net';
export const CERT_ID = 'ATL-7K2M-9Q4X-1ABZ-C3DE';

export interface TestKey {
  kid: string;
  jwk: PublicJwk;
  privateKey: CryptoKey;
}

const ascii = (s: string) => new TextEncoder().encode(s);

export async function makeKey(kid = 'Wq3nT8vP1xYc4Kf2Q', validFrom = '2026-01-01T00:00:00Z', validTo: string | null = null): Promise<TestKey> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const pub = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey;
  return {
    kid,
    privateKey: pair.privateKey,
    jwk: { kty: 'EC', crv: 'P-256', x: pub.x!, y: pub.y!, kid, use: 'sig', alg: 'ES256', 'atl:validFrom': validFrom, 'atl:validTo': validTo, 'atl:purposes': ['cert', 'revocations'] },
  };
}

export async function signJws(key: Pick<TestKey, 'kid' | 'privateKey'>, typ: string, payload: unknown, headerExtra: Record<string, unknown> = {}): Promise<string> {
  const header = { alg: 'ES256', typ, kid: key.kid, ...headerExtra };
  const signingInput = `${bytesToBase64Url(ascii(JSON.stringify(header)))}.${bytesToBase64Url(canonicalJsonBytes(payload))}`;
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key.privateKey, ascii(signingInput)));
  return `${signingInput}.${bytesToBase64Url(sig)}`;
}

export function certPayload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    kind: 'track',
    certId: CERT_ID,
    issuer: { name: 'AWS Training Lab（自托管实例）', origin: ORIGIN, installId: '3f6c1e2a-1111-4222-8333-444455556666', kid: 'Wq3nT8vP1xYc4Kf2Q' },
    subject: { displayName: '张三', ref: 'sha256:2c4f' },
    achievement: {
      trackId: 'quick-compare',
      trackVersion: '1.0.0',
      title: '七项点名对比证书',
      contentDigest: 'sha256:9a07',
      verifiedRatio: 0.86,
      labs: [
        { labId: 'svc-cdn', labVersion: '1.0.0', attemptRef: 'sha256:5d1e', reportDigest: 'sha256:placeholder', badgeLevel: 'verified', checks: { auto: 14, manual: 0 }, completedAt: '2026-10-13T08:02:11Z' },
        { labId: 'svc-auth', labVersion: '1.0.0', attemptRef: 'sha256:77aa', reportDigest: null, badgeLevel: 'attested', checks: { auto: 6, manual: 1 }, completedAt: '2026-10-14T08:02:11Z' },
      ],
    },
    issuedAt: '2026-10-20T08:10:45Z',
    nature: 'self-hosted-self-signed',
    disclaimer: '本证明由部署在学员自己 AWS 账号中的自托管 AWS Training Lab 实例自动签发，不是 AWS 官方认证。',
    verify: `${ORIGIN}/verify/${CERT_ID}`,
    ...over,
  };
}

export function jwksOf(keys: TestKey[], origins: string[] = [ORIGIN]): Jwks {
  return { installId: '3f6c1e2a-1111-4222-8333-444455556666', keys: keys.map((k) => k.jwk), origins };
}

export async function revocations(key: TestKey, seq: number, entries: { certId: string; revokedAt: string; reason: string }[]): Promise<string> {
  return signJws(key, 'atl-revocations+jws', { v: 1, installId: '3f6c1e2a', seq, issuedAt: '2026-10-21T00:00:00Z', entries });
}

/** 一份最小的 atl.report/v1 报告（用于报告核对）。 */
export function sampleReport(labId = 'svc-cdn'): Record<string, unknown> {
  return { schema: 'atl.report/v1', sessionId: 's4k7m2q9x1abc', revision: 2, generatedAt: '2026-10-13T10:48:00Z', lab: { id: labId, version: '1.0.0' }, integrity: { canonicalization: 'RFC8785', digest: 'sha256:x' } };
}
