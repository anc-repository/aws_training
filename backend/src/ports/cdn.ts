// backend/src/ports/cdn.ts   （cdn 模块；驱动 direct | cloudfront，由 CDN_BASE_URL 是否为空推导；总纲 §4.2，照录）
import type { Adapter } from './common.js';

export interface CdnPort extends Adapter {                         // cdn：direct | cloudfront
  readonly baseUrl: string | null;
  invalidate(paths: string[]): Promise<{ id: string | null; status: 'skipped' | 'submitted' }>;
  /** 01 组细化（约定 12，可选）：originUrl 来自 StoragePort.createReadUrl()；direct 原样返回，cloudfront 按可见性改写到 CDN 域名。
   *  MediaUrlBuilder 有它时调用它，否则自行按 baseUrl 改写。 */
  mediaUrl?(key: string, opts: { visibility: 'public' | 'private'; originUrl: string }): string;
}
