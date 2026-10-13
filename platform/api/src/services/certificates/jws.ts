/**
 * JWS Compact Serialization with ES256 (04 §10.3): header `{alg: ES256, typ, kid}`, payload = RFC 8785 canonical bytes,
 * signature from the SignerPort (KMS `ECDSA_SHA_256` with `MessageType=DIGEST`; dev: local P-256), IEEE P1363 `r‖s`.
 * Verification uses WebCrypto only (same algorithm as the static verify page and the offline tool).
 */
import { base64UrlToBytes, bytesToBase64Url, canonicalJsonBytes, type SignerPort } from '@atl/shared';

export const CERT_TYP = 'atl-cert+jws';
export const REVOCATIONS_TYP = 'atl-revocations+jws';
export type JwsTyp = typeof CERT_TYP | typeof REVOCATIONS_TYP;

export interface JwsHeader {
  alg: 'ES256';
  typ: JwsTyp;
  kid: string;
}

export interface PublicJwk {
  kty: 'EC';
  crv: 'P-256';
  x: string;
  y: string;
  [k: string]: unknown;
}

const ascii = (s: string) => new TextEncoder().encode(s);

export async function signJws(signer: SignerPort, key: { keyId: string; kid: string }, typ: JwsTyp, payload: unknown): Promise<{ jws: string; payloadBytes: Uint8Array }> {
  const header: JwsHeader = { alg: 'ES256', typ, kid: key.kid };
  const payloadBytes = canonicalJsonBytes(payload);
  const signingInput = `${bytesToBase64Url(ascii(JSON.stringify(header)))}.${bytesToBase64Url(payloadBytes)}`;
  const { keyId, signature } = await signer.sign({ keyId: key.keyId, message: ascii(signingInput) });
  if (keyId !== key.keyId && !keyId.endsWith(key.keyId)) throw new Error(`signed with ${keyId}, expected ${key.keyId}`);
  if (signature.length !== 64) throw new Error(`ES256 signature must be 64 bytes, got ${signature.length}`);
  return { jws: `${signingInput}.${bytesToBase64Url(signature)}`, payloadBytes };
}

export interface DecodedJws {
  header: JwsHeader;
  payload: Record<string, unknown>;
  payloadBytes: Uint8Array;
  signingInput: string;
  signature: Uint8Array;
}

export function decodeJws(jws: string): DecodedJws {
  const parts = jws.trim().split('.');
  if (parts.length !== 3) throw new TypeError('not a compact JWS');
  const [h, p, s] = parts as [string, string, string];
  const header = JSON.parse(new TextDecoder().decode(base64UrlToBytes(h))) as JwsHeader;
  const payloadBytes = base64UrlToBytes(p);
  const payload = JSON.parse(new TextDecoder().decode(payloadBytes)) as Record<string, unknown>;
  return { header, payload, payloadBytes, signingInput: `${h}.${p}`, signature: base64UrlToBytes(s) };
}

/** WebCrypto ES256 verification of a decoded JWS against a public JWK. */
export async function verifySignature(d: DecodedJws, jwk: PublicJwk): Promise<boolean> {
  const subtle = globalThis.crypto.subtle;
  const key = await subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, ext: true }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  if (d.signature.length !== 64) return false;
  return subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, d.signature, ascii(d.signingInput));
}
