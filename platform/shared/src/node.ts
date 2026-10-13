/**
 * Node-only helpers (`@atl/shared/node`): anything that needs `node:crypto`. Not re-exported from the package root so that
 * browser bundles of `@atl/shared` stay free of Node built-ins.
 */
import { createHash } from 'node:crypto';
import { bytesToBase64Url } from './encoding.js';

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export function sha256(data: string | Uint8Array): Uint8Array {
  return new Uint8Array(createHash('sha256').update(data).digest());
}

/**
 * Reclaim ledger key (01 §7.2): first 32 hex chars of SHA-256(`<region>|<ARN>`), or of `<region>|<type>:<id>` when the
 * resource has no ARN. The original value is stored as an attribute.
 */
export function resourceKey(region: string, ref: { arn: string } | { resourceType: string; id: string }): string {
  if (!region) throw new TypeError('region is required');
  const what = 'arn' in ref ? ref.arn : `${ref.resourceType}:${ref.id}`;
  if (!what) throw new TypeError('ARN or type:id is required');
  return sha256Hex(`${region}|${what}`).slice(0, 32);
}

export interface EcPublicJwk {
  kty: 'EC';
  crv: 'P-256';
  x: string;
  y: string;
}

/** RFC 7638 JWK thumbprint (base64url SHA-256 of the required members in lexicographic order) = `kid` (01 §3.9). */
export function jwkThumbprint(jwk: EcPublicJwk): string {
  const canonical = `{"crv":"${jwk.crv}","kty":"${jwk.kty}","x":"${jwk.x}","y":"${jwk.y}"}`;
  return bytesToBase64Url(sha256(canonical));
}
