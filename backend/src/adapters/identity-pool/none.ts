// backend/src/adapters/identity-pool/none.ts —— DirectUploadPort 的 `none` 驱动（本地实现）
// F14 本地前缀上传令牌（upload-hmac-key）：raw/<userId>/ 下多次分片 PUT
// 脚手架桩：方法抛出 NotImplementedError（HTTP 层映射为 501）。由「L0 本地实现者」填充。
import type { AdapterDeps } from '../types.js';
import type { AdapterMeta, ProbeResult } from '../../ports/common.js';
import type { DirectUploadPort, DirectUploadSession } from '../../ports/direct-upload.js';
import type { Principal } from '../../ports/auth.js';
import { notImplemented } from '../../errors.js';

export class PrefixTokenUpload implements DirectUploadPort {
  readonly meta: AdapterMeta = { module: 'identity-pool', driver: 'none', awsService: null, authoritative: false };

  constructor(protected readonly deps: AdapterDeps) {}

  async probe(_opts?: { deep?: boolean }): Promise<ProbeResult> {
    throw notImplemented('PrefixTokenUpload', 'probe', 'identity-pool');
  }

  async openSession(_who: Principal, _opts?: { bypass?: boolean }): Promise<DirectUploadSession> {
    throw notImplemented('PrefixTokenUpload', 'openSession', 'identity-pool');
  }

  async complete(_photoId: string, _who: Principal): Promise<{ ok: boolean; rawKey?: string; reason?: string }> {
    throw notImplemented('PrefixTokenUpload', 'complete', 'identity-pool');
  }

  async authorizePart(_token: string, _key: string, _uploadId: string, _part: number): Promise<{ url?: string }> {
    throw notImplemented('PrefixTokenUpload', 'authorizePart', 'identity-pool');
  }
}
