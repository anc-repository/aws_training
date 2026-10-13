// backend/src/adapters/cdn/direct.ts —— CdnPort 的 `direct` 驱动（本地实现，01#cdn 第 1 节）
// EC2 上的 Nginx 直出：baseUrl = null；mediaUrl() 原样返回 StoragePort 给出的源站 URL（/media/<key>，私有媒体带 exp、sig）；
// invalidate() 返回 skipped（没有边缘缓存可失效）。路径头中不出现 cdn 段（direct 不是请求路径上的一跳）。
import type { AdapterDeps } from '../types.js';
import type { AdapterMeta, ProbeResult } from '../../ports/common.js';
import type { CdnPort } from '../../ports/cdn.js';

export class DirectCdn implements CdnPort {
  readonly meta: AdapterMeta = { module: 'cdn', driver: 'direct', awsService: null, authoritative: false };
  readonly baseUrl: string | null;

  constructor(protected readonly deps: AdapterDeps) {
    this.baseUrl = null;
  }

  async probe(_opts?: { deep?: boolean }): Promise<ProbeResult> {
    return { status: 'ok', detail: '页面、静态资源与图片由 EC2 上的 Nginx 直出（浏览器缓存照常生效，没有边缘缓存）', confidence: 'confirmed' };
  }

  mediaUrl(_key: string, opts: { visibility: 'public' | 'private'; originUrl: string }): string {
    return opts.originUrl;
  }

  async invalidate(_paths: string[]): Promise<{ id: string | null; status: 'skipped' | 'submitted' }> {
    return { id: null, status: 'skipped' };
  }
}
