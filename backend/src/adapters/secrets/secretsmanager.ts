// backend/src/adapters/secrets/secretsmanager.ts —— SecretsPort 的 `secretsmanager` 驱动（AWS Secrets Manager）
// GetSecretValue + TTL 缓存（本轮未实现）
// 脚手架桩：方法抛出 NotImplementedError（HTTP 层映射为 501）。由「后续版本（本轮 MVP 不实现；配置该驱动会被 config/implemented.ts 以 CFG-001 拒绝）」填充。
import type { AdapterDeps } from '../types.js';
import type { AdapterMeta, ProbeResult } from '../../ports/common.js';
import type { SecretName, SecretsPort } from '../../ports/secrets.js';
import { notImplemented } from '../../errors.js';

export class SmSecrets implements SecretsPort {
  readonly meta: AdapterMeta = { module: 'secrets', driver: 'secretsmanager', awsService: 'AWS Secrets Manager', authoritative: true };

  constructor(protected readonly deps: AdapterDeps) {}

  async probe(_opts?: { deep?: boolean }): Promise<ProbeResult> {
    throw notImplemented('SmSecrets', 'probe', 'secrets');
  }

  async get(_name: SecretName): Promise<string> {
    throw notImplemented('SmSecrets', 'get', 'secrets');
  }

  async describe(_name: SecretName): Promise<{ source: 'env' | 'secretsmanager'; origin: 'instance' | 'bundle' | 'aws'; version?: string; lastRotatedAt?: string }> {
    throw notImplemented('SmSecrets', 'describe', 'secrets');
  }

  onRotate(_name: SecretName, _cb: (next: string) => void): () => void {
    throw notImplemented('SmSecrets', 'onRotate', 'secrets');
  }
}
