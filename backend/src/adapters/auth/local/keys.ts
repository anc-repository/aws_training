// backend/src/adapters/auth/local/keys.ts —— ES256 签名密钥（当前 + 上一版本）与 JWKS（D8）
//
// - 当前私钥：SecretsPort.get('jwt-signing-key')（env 驱动 = JWT_SIGNING_KEY_FILE 指向的 PEM 内容）。
// - 上一版本：与当前私钥同目录的 `<name>.prev.pem`（`scripts/secrets rotate jwt-signing-key` 先把当前私钥改名为 prev，
//   再生成新私钥），只用于验签与 JWKS 发布，不再用于签发。
// - kid = RFC 7638 JWK 指纹（base64url），轮换后自然变化。
// PEM 可以是 PKCS#8（openssl genpkey）或 SEC1（openssl ecparam -genkey），统一经 node:crypto 解析后转成 jose 的密钥。
import { createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';
import { calculateJwkThumbprint, importJWK, importPKCS8, type CryptoKey, type JWK } from 'jose';

export const JWT_ALG = 'ES256';

export interface SigningKey {
  kid: string;
  /** 签名用（只有当前版本会用到） */
  privateKey: CryptoKey;
  /** 验签用 */
  publicKey: CryptoKey;
  /** 发布到 JWKS 的公钥（含 kid / alg / use） */
  publicJwk: Record<string, string>;
}

export class SigningKeyError extends Error {
  readonly code = 'JWT_SIGNING_KEY_INVALID';
  constructor(message: string) {
    super(message);
    this.name = 'SigningKeyError';
  }
}

function assertP256(key: KeyObject): void {
  if (key.asymmetricKeyType !== 'ec') throw new SigningKeyError(`签名私钥类型为 ${key.asymmetricKeyType ?? '未知'}，需要 EC P-256（ES256）`);
  const curve = key.asymmetricKeyDetails?.namedCurve;
  if (curve && curve !== 'prime256v1' && curve !== 'P-256') throw new SigningKeyError(`签名私钥曲线为 ${curve}，需要 P-256（ES256）`);
}

/** 解析 PEM 私钥 → 签名 / 验签密钥 + JWK（含 kid） */
export async function loadSigningKey(pem: string): Promise<SigningKey> {
  let priv: KeyObject;
  try {
    priv = createPrivateKey({ key: pem, format: 'pem' });
  } catch (e) {
    throw new SigningKeyError(`无法解析 ES256 私钥 PEM：${(e as Error).message}`);
  }
  assertP256(priv);
  const pub = createPublicKey(priv);
  const jwk = pub.export({ format: 'jwk' }) as JWK;
  const kid = await calculateJwkThumbprint({ kty: jwk.kty!, crv: jwk.crv!, x: jwk.x!, y: jwk.y! });
  const pkcs8 = priv.export({ format: 'pem', type: 'pkcs8' }).toString();
  const privateKey = await importPKCS8(pkcs8, JWT_ALG);
  const publicKey = (await importJWK({ kty: jwk.kty!, crv: jwk.crv!, x: jwk.x!, y: jwk.y! }, JWT_ALG)) as CryptoKey;
  return {
    kid,
    privateKey,
    publicKey,
    publicJwk: { kty: jwk.kty!, crv: jwk.crv!, x: jwk.x!, y: jwk.y!, kid, alg: JWT_ALG, use: 'sig' },
  };
}

/** `/x/jwt-es256.pem` → `/x/jwt-es256.prev.pem` */
export function previousKeyPath(currentPath: string): string {
  return /\.pem$/i.test(currentPath) ? currentPath.replace(/\.pem$/i, '.prev.pem') : `${currentPath}.prev`;
}
