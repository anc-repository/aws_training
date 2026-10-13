/**
 * Local ECDSA P-256 signer replacing the KMS asymmetric key in dev. The private key is a PKCS#8 PEM under
 * `<dataDir>/keys/<keyId>.pem` (generated on first use; `.atl-dev/` and `*.pem` are git-ignored).
 * Same contract as production: ES256 over SHA-256(message), IEEE P1363 output.
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign as nodeSign, type KeyObject } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PortError, type EcPublicJwkLike, type SignerPort } from '@atl/shared';

export class LocalEcdsaSigner implements SignerPort {
  private readonly keys = new Map<string, KeyObject>();

  constructor(private readonly keyDir: string) {}

  private key(keyId: string): KeyObject {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(keyId)) throw new PortError('InvalidInput', `invalid dev key id: ${keyId}`);
    let k = this.keys.get(keyId);
    if (k) return k;
    const file = path.join(this.keyDir, `${keyId}.pem`);
    if (!fs.existsSync(file)) {
      fs.mkdirSync(this.keyDir, { recursive: true });
      const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
      fs.writeFileSync(file, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    }
    k = createPrivateKey(fs.readFileSync(file));
    this.keys.set(keyId, k);
    return k;
  }

  async sign(req: { keyId: string; message: Uint8Array }) {
    const signature = nodeSign('sha256', req.message, { key: this.key(req.keyId), dsaEncoding: 'ieee-p1363' });
    return { keyId: req.keyId, signature: new Uint8Array(signature) };
  }

  async getPublicKey(keyId: string) {
    const pub = createPublicKey(this.key(keyId));
    const jwk = pub.export({ format: 'jwk' }) as { x: string; y: string };
    const spkiDer = new Uint8Array(pub.export({ format: 'der', type: 'spki' }));
    return { keyId, spkiDer, jwk: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y } as EcPublicJwkLike };
  }
}
