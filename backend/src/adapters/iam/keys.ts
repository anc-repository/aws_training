// backend/src/adapters/iam/keys.ts —— AwsCredentialsPort 的 `keys` 驱动（AWS IAM）
// 从分层 env（secrets.env）的 IAM_KEYS_* 读取长期密钥，显式传给客户端工厂；CRED-002 反面教材
// 脚手架桩：方法抛出 NotImplementedError（HTTP 层映射为 501）。由「iam 模块实现者」填充。
import type { AdapterDeps } from '../types.js';
import type { AdapterMeta, ProbeResult } from '../../ports/common.js';
import type { AwsCredentials, AwsCredentialsPort } from '../../ports/aws-credentials.js';
import { notImplemented } from '../../errors.js';

export class KeysCredentials implements AwsCredentialsPort {
  readonly meta: AdapterMeta = { module: 'iam', driver: 'keys', awsService: 'AWS IAM', authoritative: false };
  readonly mode = 'keys' as const;

  constructor(protected readonly deps: AdapterDeps) {}

  async probe(_opts?: { deep?: boolean }): Promise<ProbeResult> {
    throw notImplemented('KeysCredentials', 'probe', 'iam');
  }

  provider(): (() => Promise<AwsCredentials>) | null {
    throw notImplemented('KeysCredentials', 'provider', 'iam');
  }

  async describe(): Promise<{ kind: 'none' | 'assumed-role' | 'user'; arn?: string; keyPrefix?: 'ASIA' | 'AKIA'; expiresAt?: string }> {
    throw notImplemented('KeysCredentials', 'describe', 'iam');
  }

  async forceRefresh(): Promise<void> {
    throw notImplemented('KeysCredentials', 'forceRefresh', 'iam');
  }
}
