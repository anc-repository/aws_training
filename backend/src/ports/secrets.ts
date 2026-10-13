// backend/src/ports/secrets.ts （总纲 §4.2，照录）
import type { Adapter } from './common.js';

/** 共 12 个逻辑名。env 驱动：变量名 = 逻辑名转大写下划线（UPLOAD_HMAC_KEY、COGNITO_CLIENT_SECRET…），
 *  值是文件路径时加 _FILE 后缀（JWT_SIGNING_KEY_FILE、CLOUDFRONT_SIGNING_KEY_FILE），只能出现在 secrets.env；
 *  secretsmanager 驱动：名称为 cloudalbum/<env>/<逻辑名>（RDS 托管主密码例外，用 DB_PASSWORD_SECRET_ARN） */
export type SecretName =
  | 'jwt-signing-key' | 'upload-hmac-key' | 'media-hmac-key' | 'callback-hmac-key' | 'internal-hmac-key'
  | 'cookie-secret' | 'local-master-key' | 'db-password' | 'redis-auth-token' | 'origin-verify'
  | 'cognito-client-secret' | 'cloudfront-signing-key';

export const SECRET_NAMES: readonly SecretName[] = [
  'jwt-signing-key', 'upload-hmac-key', 'media-hmac-key', 'callback-hmac-key', 'internal-hmac-key',
  'cookie-secret', 'local-master-key', 'db-password', 'redis-auth-token', 'origin-verify',
  'cognito-client-secret', 'cloudfront-signing-key',
];

/** 值以文件形式提供的逻辑名（env 变量加 _FILE 后缀） */
export const FILE_SECRETS: ReadonlySet<SecretName> = new Set<SecretName>(['jwt-signing-key', 'cloudfront-signing-key']);

/** env 驱动的变量名：逻辑名转大写下划线；文件型加 _FILE（例如 jwt-signing-key → JWT_SIGNING_KEY_FILE） */
export function secretEnvName(name: SecretName): string {
  const base = name.toUpperCase().replace(/-/g, '_');
  return FILE_SECRETS.has(name) ? `${base}_FILE` : base;
}

export interface SecretsPort extends Adapter {
  get(name: SecretName): Promise<string>;               // secretsmanager 档带 TTL 缓存（默认 300s）
  describe(name: SecretName): Promise<{
    source: 'env' | 'secretsmanager';
    origin: 'instance' | 'bundle' | 'aws';              // instance = 本机 User Data 生成（多实例不安全）
    version?: string; lastRotatedAt?: string;
  }>;
  onRotate(name: SecretName, cb: (next: string) => void): () => void;   // db-password 轮换后重建连接池
}
