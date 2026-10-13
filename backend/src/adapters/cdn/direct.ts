// backend/src/adapters/cdn/direct.ts —— CdnPort 的 `direct` 驱动（本地实现）
// EC2 直出：baseUrl = null，invalidate() 返回 skipped
// 脚手架桩：方法抛出 NotImplementedError（HTTP 层映射为 501）。由「L0 本地实现者」填充。
import type { AdapterDeps } from '../types.js';
import type { AdapterMeta, ProbeResult } from '../../ports/common.js';
import type { CdnPort } from '../../ports/cdn.js';
import { notImplemented } from '../../errors.js';

export class DirectCdn implements CdnPort {
  readonly meta: AdapterMeta = { module: 'cdn', driver: 'direct', awsService: null, authoritative: false };
  readonly baseUrl: string | null;

  constructor(protected readonly deps: AdapterDeps) {
    this.baseUrl = null;
  }

  async probe(_opts?: { deep?: boolean }): Promise<ProbeResult> {
    throw notImplemented('DirectCdn', 'probe', 'cdn');
  }

  async invalidate(_paths: string[]): Promise<{ id: string | null; status: 'skipped' | 'submitted' }> {
    throw notImplemented('DirectCdn', 'invalidate', 'cdn');
  }
}
