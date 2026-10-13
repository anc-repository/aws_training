// backend/src/adapters/cdn/cloudfront.ts —— CdnPort 的 `cloudfront` 驱动（Amazon CloudFront）
// CDN_BASE_URL 改写媒体 URL；CreateInvalidation（失效按钮，需要凭证）
// 脚手架桩：方法抛出 NotImplementedError（HTTP 层映射为 501）。由「cdn 模块实现者」填充。
import type { AdapterDeps } from '../types.js';
import type { AdapterMeta, ProbeResult } from '../../ports/common.js';
import type { CdnPort } from '../../ports/cdn.js';
import { notImplemented } from '../../errors.js';

export class CloudFrontCdn implements CdnPort {
  readonly meta: AdapterMeta = { module: 'cdn', driver: 'cloudfront', awsService: 'Amazon CloudFront', authoritative: false };
  readonly baseUrl: string | null;

  constructor(protected readonly deps: AdapterDeps) {
    this.baseUrl = deps.cfg.core.CDN_BASE_URL || null;
  }

  async probe(_opts?: { deep?: boolean }): Promise<ProbeResult> {
    throw notImplemented('CloudFrontCdn', 'probe', 'cdn');
  }

  async invalidate(_paths: string[]): Promise<{ id: string | null; status: 'skipped' | 'submitted' }> {
    throw notImplemented('CloudFrontCdn', 'invalidate', 'cdn');
  }
}
