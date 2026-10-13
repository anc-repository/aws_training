// backend/src/adapters/iam/keys.ts —— AwsCredentialsPort 的 `keys` 驱动（AWS IAM；CRED-002 反面教材）
//
// 从分层 env 第 3 层（secrets.env）的 IAM_KEYS_ACCESS_KEY_ID / IAM_KEYS_SECRET_ACCESS_KEY 读取长期密钥，构造静态 provider，
// 显式传给 adapters/aws/clients.ts（不导出到进程环境变量；键名刻意不用 AWS_ACCESS_KEY_ID，避免被 SDK 默认链或子进程拾取）。
// 探针：sts:GetCallerIdentity + iam:GetUser（演示用户自身）；keys 模式始终至少 degraded（02#iam 第 10 节）。
import type { AdapterDeps } from '../types.js';
import type { AwsClients } from '../aws/clients.js';
import type { AdapterMeta, ProbeResult } from '../../ports/common.js';
import type { AwsCredentials, AwsCredentialsPort } from '../../ports/aws-credentials.js';
import { describeCaller, probeClients, probeWithDetector, type CredentialDescription } from './shared.js';

export class KeysCredentials implements AwsCredentialsPort {
  readonly meta: AdapterMeta = { module: 'iam', driver: 'keys', awsService: 'AWS IAM', authoritative: false };
  readonly mode = 'keys' as const;
  private clients?: AwsClients;

  constructor(protected readonly deps: AdapterDeps) {}

  private keys(): AwsCredentials {
    const { IAM_KEYS_ACCESS_KEY_ID: accessKeyId, IAM_KEYS_SECRET_ACCESS_KEY: secretAccessKey } = this.deps.cfg.iam;
    if (!accessKeyId || !secretAccessKey) {
      // zod 已校验（IAM_CREDENTIALS=keys 时两项必填）；这里只是兜底
      throw new Error('IAM_CREDENTIALS=keys，但 secrets.env 中没有 IAM_KEYS_ACCESS_KEY_ID / IAM_KEYS_SECRET_ACCESS_KEY');
    }
    return { accessKeyId, secretAccessKey };
  }

  private aws(): AwsClients {
    this.clients ??= probeClients(this.deps, this.provider());
    return this.clients;
  }

  async probe(opts: { deep?: boolean } = {}): Promise<ProbeResult> {
    const r = await probeWithDetector(this.deps, this.aws(), opts);
    // keys 始终至少 degraded（CRED-002）；探针成功时 IamDetector 已按此处理，这里只补一句 data
    return { ...r, data: { ...(r.data ?? {}), source: 'static' } };
  }

  provider(): () => Promise<AwsCredentials> {
    const creds = this.keys();
    return async () => ({ ...creds });
  }

  async describe(): Promise<CredentialDescription> {
    return describeCaller(this.aws());
  }

  async forceRefresh(): Promise<void> {
    /* 静态密钥没有可刷新的会话；轮换由部署者改写 secrets.env 后重启 */
  }

  async close(): Promise<void> {
    this.clients?.destroy();
  }
}
