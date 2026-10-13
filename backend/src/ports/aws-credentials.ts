// backend/src/ports/aws-credentials.ts   （iam 模块；驱动 none | role | keys；总纲 §4.2，照录）
import type { Adapter } from './common.js';

export interface AwsCredentials { accessKeyId: string; secretAccessKey: string; sessionToken?: string; expiration?: Date }
export interface AwsCredentialsPort extends Adapter {
  readonly mode: 'none' | 'role' | 'keys';
  /** none：返回 null，adapters/aws/clients.ts 拒绝创建任何客户端（CRED-001 已在启动时拦截）；
   *  role：IMDSv2 实例角色凭证；keys：从 secrets.env 的 IAM_KEYS_* 读取，显式传给客户端工厂（不导出到进程环境变量） */
  provider(): (() => Promise<AwsCredentials>) | null;
  describe(): Promise<{ kind: 'none' | 'assumed-role' | 'user'; arn?: string; keyPrefix?: 'ASIA' | 'AKIA'; expiresAt?: string }>;
  /** role：撤销会话实验后重新从 IMDS 取凭证（配合 replace-iam-instance-profile-association） */
  forceRefresh(): Promise<void>;
}
