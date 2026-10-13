// backend/src/adapters/secrets/env.ts —— SecretsPort 的 `env` 驱动（本地实现）
// 从分层 env 读取（不是 process.env）：变量名 = secretEnvName(逻辑名)，*_FILE 读文件
// 脚手架桩：方法抛出 NotImplementedError（HTTP 层映射为 501）。由「L0 本地实现者」填充。
import type { AdapterDeps } from '../types.js';
import type { AdapterMeta, ProbeResult } from '../../ports/common.js';
import type { SecretName, SecretsPort } from '../../ports/secrets.js';
import { notImplemented } from '../../errors.js';

export class EnvSecrets implements SecretsPort {
  readonly meta: AdapterMeta = { module: 'secrets', driver: 'env', awsService: null, authoritative: true };

  constructor(protected readonly deps: AdapterDeps) {}

  async probe(_opts?: { deep?: boolean }): Promise<ProbeResult> {
    throw notImplemented('EnvSecrets', 'probe', 'secrets');
  }

  async get(_name: SecretName): Promise<string> {
    throw notImplemented('EnvSecrets', 'get', 'secrets');
  }

  async describe(_name: SecretName): Promise<{ source: 'env' | 'secretsmanager'; origin: 'instance' | 'bundle' | 'aws'; version?: string; lastRotatedAt?: string }> {
    throw notImplemented('EnvSecrets', 'describe', 'secrets');
  }

  onRotate(_name: SecretName, _cb: (next: string) => void): () => void {
    throw notImplemented('EnvSecrets', 'onRotate', 'secrets');
  }
}
