/**
 * JwksPublish (01 §4.6, 04 §10): reads the public key of the KMS signing key, records it as `SigningKey` (`KEY#<kid> / META`,
 * kid = RFC 7638 thumbprint) and publishes `/.well-known/atl/jwks.json` with every key ever used (old keys stay valid for
 * verification after a rotation, 01 §10.5). The signed revocation list needs kms:Sign, which only atl-certs has (01 §6.9),
 * so it is not written here (see docs/implementation-notes.md, platform-infra).
 */
import { createPublicKey } from 'node:crypto';
import { Gsi1, Keys, WebKeys } from '@atl/shared';
import { jwkThumbprint, type EcPublicJwk } from '@atl/shared/node';
import type { CfnEvent, CfnResult } from '../cfn.js';
import { defaultPhysicalId, prop } from '../cfn.js';
import type { Item, Ports } from '../ports.js';

export function publicJwkFromDer(der: Uint8Array): { jwk: EcPublicJwk; pem: string } {
  const key = createPublicKey({ key: Buffer.from(der), format: 'der', type: 'spki' });
  const jwk = key.export({ format: 'jwk' }) as { kty?: string; crv?: string; x?: string; y?: string };
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.x || !jwk.y) throw new Error('the signing key is not an EC P-256 key');
  return { jwk: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }, pem: String(key.export({ format: 'pem', type: 'spki' })) };
}

export async function jwksPublish(event: CfnEvent, ports: Ports): Promise<CfnResult> {
  const id = defaultPhysicalId(event);
  if (event.RequestType === 'Delete') return { physicalResourceId: id };
  const table = prop(event, 'Table');
  const keyId = prop(event, 'KeyId');
  const webBucket = prop(event, 'WebBucket');
  const pub = await ports.kms.getPublicKey(keyId);
  if (pub.keySpec !== 'ECC_NIST_P256') throw new Error(`unexpected key spec ${pub.keySpec}`);
  const { jwk, pem } = publicJwkFromDer(pub.der);
  const kid = jwkThumbprint(jwk);
  const now = ports.now().toISOString();
  await ports.table.put(
    table,
    {
      ...Keys.signingKey(kid),
      ...Gsi1.signingKey(now),
      type: 'SigningKey',
      ver: 1,
      createdAt: now,
      updatedAt: now,
      kid,
      keyId: pub.keyArn || keyId,
      alg: 'ES256',
      publicKeyPem: pem,
      jwk: { ...jwk, kid, alg: 'ES256', use: 'sig' },
      validFrom: now,
      validTo: null,
      purposes: ['certificate', 'revocation-list'],
    },
    { ifNotExists: true },
  );
  const keys: Item[] = await ports.table.queryIndex(table, 'GSI1', 'KEYS', 100);
  const jwks = keys
    .filter((k) => k.type === 'SigningKey' && k.jwk && typeof k.jwk === 'object')
    .map((k) => k.jwk as Item)
    .sort((a, b) => String(a.kid).localeCompare(String(b.kid)));
  if (!jwks.some((k) => k.kid === kid)) jwks.push({ ...jwk, kid, alg: 'ES256', use: 'sig' });
  await ports.s3.putObject(webBucket, WebKeys.jwks, JSON.stringify({ keys: jwks }, null, 2) + '\n', {
    contentType: 'application/json',
    cacheControl: 'public, max-age=60',
  });
  const dist = event.ResourceProperties.DistributionId;
  if (typeof dist === 'string' && dist) await ports.cdn.invalidate(dist, ['/.well-known/atl/*']);
  return { physicalResourceId: id, data: { Kid: kid } };
}
