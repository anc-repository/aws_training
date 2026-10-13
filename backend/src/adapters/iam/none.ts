// backend/src/adapters/iam/none.ts —— AwsCredentialsPort 的 `none` 驱动（本地实现）
// IAM_CREDENTIALS=none：L0 不访问 AWS；provider() 返回 null，describe() 返回 { kind: "none" }
// 脚手架桩：方法抛出 NotImplementedError（HTTP 层映射为 501）。由「L0 本地实现者」填充。
import type { AdapterDeps } from '../types.js';
import type { AdapterMeta, ProbeResult } from '../../ports/common.js';
import type { AwsCredentials, AwsCredentialsPort } from '../../ports/aws-credentials.js';
import { notImplemented } from '../../errors.js';

export class NoCredentials implements AwsCredentialsPort {
  readonly meta: AdapterMeta = { module: 'iam', driver: 'none', awsService: null, authoritative: false };
  readonly mode = 'none' as const;

  constructor(protected readonly deps: AdapterDeps) {}

  async probe(_opts?: { deep?: boolean }): Promise<ProbeResult> {
    throw notImplemented('NoCredentials', 'probe', 'iam');
  }

  provider(): (() => Promise<AwsCredentials>) | null {
    throw notImplemented('NoCredentials', 'provider', 'iam');
  }

  async describe(): Promise<{ kind: 'none' | 'assumed-role' | 'user'; arn?: string; keyPrefix?: 'ASIA' | 'AKIA'; expiresAt?: string }> {
    throw notImplemented('NoCredentials', 'describe', 'iam');
  }

  async forceRefresh(): Promise<void> {
    throw notImplemented('NoCredentials', 'forceRefresh', 'iam');
  }
}
