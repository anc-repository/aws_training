// backend/src/adapters/iam/shared.ts —— role / keys 两个驱动共用的探针与 describe（02#iam 第 2、10 节）
//
// 探针复用 modules/detectors/iam.ts 的 IamDetector（① sts:GetCallerIdentity ② iam:GetRole / iam:GetUser、残留长期密钥、
// 预期角色名、keys 模式至少 degraded）。驱动在 container 的第 4 步创建，那时 AwsClients 还没有凭证，所以探针自己用
// provider() 建一组只读客户端（同一 region / 端点覆盖）。
import { lazyAwsClients, type AwsClients } from '../aws/clients.js';
import { checkCallerAndAuthorization, IamDetector } from '../../modules/detectors/iam.js';
import type { AwsCredentials } from '../../ports/aws-credentials.js';
import type { ProbeResult } from '../../ports/common.js';
import type { AdapterDeps } from '../types.js';

export type CredentialKind = 'none' | 'assumed-role' | 'user';

export interface CredentialDescription {
  kind: CredentialKind;
  arn?: string;
  keyPrefix?: 'ASIA' | 'AKIA';
  expiresAt?: string;
}

/** 用给定 provider 建一组客户端（探针 / describe 专用） */
export function probeClients(deps: AdapterDeps, provider: () => Promise<AwsCredentials>): AwsClients {
  const endpoint = deps.cfg.core.AWS_ENDPOINT_URL;
  return lazyAwsClients({
    region: deps.cfg.core.AWS_REGION,
    credentials: provider,
    maxAttempts: 2,
    ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
  });
}

export async function probeWithDetector(deps: AdapterDeps, aws: AwsClients, opts: { deep?: boolean } = {}): Promise<ProbeResult> {
  const det = new IamDetector({ cfg: deps.cfg, env: deps.env, aws });
  return det.detect(opts);
}

export async function describeCaller(aws: AwsClients): Promise<CredentialDescription> {
  const c = await checkCallerAndAuthorization(aws);
  if (!c.authenticated) throw new Error(`GetCallerIdentity 失败：${c.authError ?? 'unknown'}`);
  const kind: CredentialKind = c.kind === 'assumed-role' ? 'assumed-role' : 'user';
  return {
    kind,
    ...(c.arn ? { arn: c.arn } : {}),
    ...(c.keyPrefix ? { keyPrefix: c.keyPrefix } : {}),
    ...(c.expiresAt ? { expiresAt: c.expiresAt } : {}),
  };
}
