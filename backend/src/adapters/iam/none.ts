// backend/src/adapters/iam/none.ts —— AwsCredentialsPort 的 `none` 驱动（本地实现）
// IAM_CREDENTIALS=none：L0 不访问 AWS；provider() 返回 null（adapters/aws/clients.ts 因此拒绝创建任何 SDK 客户端），
// describe() 返回 { kind: "none" }。CRED-001 在启动时已拦截“启用了要调用 AWS 的模块却没有凭证”的组合（02#iam 第 1 节）。
import type { AdapterDeps } from '../types.js';
import type { AdapterMeta, ProbeResult } from '../../ports/common.js';
import type { AwsCredentials, AwsCredentialsPort } from '../../ports/aws-credentials.js';
import { residualKeyFindings } from '../../modules/detectors/iam.js';

export class NoCredentials implements AwsCredentialsPort {
  readonly meta: AdapterMeta = { module: 'iam', driver: 'none', awsService: null, authoritative: false };
  readonly mode = 'none' as const;

  constructor(protected readonly deps: AdapterDeps, private readonly processEnv: NodeJS.ProcessEnv = process.env) {}

  async probe(_opts?: { deep?: boolean }): Promise<ProbeResult> {
    // 只做本地检查：残留的 AWS_* 环境变量不影响 none（SDK 根本不会被加载），但值得在 /lab 上指出
    const residual = residualKeyFindings('none', this.processEnv, this.deps.env);
    return {
      status: 'ok',
      detail: residual.length ? `应用未调用任何 AWS API（注意：${residual.join('；')}）` : '应用未调用任何 AWS API',
      confidence: 'confirmed',
      data: { mode: 'none', residualKeys: residual },
    };
  }

  provider(): (() => Promise<AwsCredentials>) | null {
    return null;
  }

  async describe(): Promise<{ kind: 'none' | 'assumed-role' | 'user'; arn?: string; keyPrefix?: 'ASIA' | 'AKIA'; expiresAt?: string }> {
    return { kind: 'none' };
  }

  async forceRefresh(): Promise<void> {
    /* 没有凭证可刷新 */
  }
}
