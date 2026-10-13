// backend/src/adapters/iam/role.ts —— AwsCredentialsPort 的 `role` 驱动（AWS IAM）
// IMDSv2 实例角色凭证（@aws-sdk/credential-providers 的 fromInstanceMetadata）；探针 sts:GetCallerIdentity + iam:GetRole
// 脚手架桩：方法抛出 NotImplementedError（HTTP 层映射为 501）。由「iam 模块实现者」填充。
import type { AdapterDeps } from '../types.js';
import type { AdapterMeta, ProbeResult } from '../../ports/common.js';
import type { AwsCredentials, AwsCredentialsPort } from '../../ports/aws-credentials.js';
import { notImplemented } from '../../errors.js';

export class RoleCredentials implements AwsCredentialsPort {
  readonly meta: AdapterMeta = { module: 'iam', driver: 'role', awsService: 'AWS IAM', authoritative: false };
  readonly mode = 'role' as const;

  constructor(protected readonly deps: AdapterDeps) {}

  async probe(_opts?: { deep?: boolean }): Promise<ProbeResult> {
    throw notImplemented('RoleCredentials', 'probe', 'iam');
  }

  provider(): (() => Promise<AwsCredentials>) | null {
    throw notImplemented('RoleCredentials', 'provider', 'iam');
  }

  async describe(): Promise<{ kind: 'none' | 'assumed-role' | 'user'; arn?: string; keyPrefix?: 'ASIA' | 'AKIA'; expiresAt?: string }> {
    throw notImplemented('RoleCredentials', 'describe', 'iam');
  }

  async forceRefresh(): Promise<void> {
    throw notImplemented('RoleCredentials', 'forceRefresh', 'iam');
  }
}
