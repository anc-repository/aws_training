// backend/src/adapters/identity-pool/cognito.ts —— DirectUploadPort 的 `cognito` 驱动（Amazon Cognito Identity Pool）
// 本轮未实现
// 脚手架桩：方法抛出 NotImplementedError（HTTP 层映射为 501）。由「后续版本（本轮 MVP 不实现；配置该驱动会被 config/implemented.ts 以 CFG-001 拒绝）」填充。
import type { AdapterDeps } from '../types.js';
import type { AdapterMeta, ProbeResult } from '../../ports/common.js';
import type { DirectUploadPort, DirectUploadSession, TempAwsCredentials } from '../../ports/direct-upload.js';
import type { Principal } from '../../ports/auth.js';
import { notImplemented } from '../../errors.js';

export class CognitoDirectUpload implements DirectUploadPort {
  readonly meta: AdapterMeta = { module: 'identity-pool', driver: 'cognito', awsService: 'Amazon Cognito Identity Pool', authoritative: false };

  constructor(protected readonly deps: AdapterDeps) {}

  async probe(_opts?: { deep?: boolean }): Promise<ProbeResult> {
    throw notImplemented('CognitoDirectUpload', 'probe', 'identity-pool');
  }

  async openSession(_who: Principal, _opts?: { bypass?: boolean }): Promise<DirectUploadSession> {
    throw notImplemented('CognitoDirectUpload', 'openSession', 'identity-pool');
  }

  async complete(_photoId: string, _who: Principal): Promise<{ ok: boolean; rawKey?: string; reason?: string }> {
    throw notImplemented('CognitoDirectUpload', 'complete', 'identity-pool');
  }

  async credentials(_who: Principal, _idToken: string): Promise<TempAwsCredentials> {
    throw notImplemented('CognitoDirectUpload', 'credentials', 'identity-pool');
  }
}
