// backend/src/services/media-url.ts —— MediaUrlBuilder（总纲 4.1；01#cdn 第 1 节；03#storage 第 2 节）
//
// 数据库与缓存里只有逻辑键；URL 在响应时生成：
//   1. StoragePort.createReadUrl(key, { visibility, expiresInSec }) 得到源站 URL
//      （local：/media/<key>，私有媒体带 exp、sig；s3：预签名 GET）；
//   2. 管理员 X-Compare-Bypass: cdn → 直接返回源站 URL（路径头 cdn=<驱动>:bypass）；
//   3. 否则交给 CdnPort.mediaUrl()（cloudfront 驱动按可见性改写到 CDN 域名；direct 原样返回）；
//      CdnPort 没有 mediaUrl 时，公开且为相对路径的源站 URL 拼上 CdnPort.baseUrl。
// variants/ 一律按 public 处理（UUID 不可猜测、URL 稳定便于缓存）；raw/、reports/ 一律 private。
import type { CdnPort } from '../ports/cdn.js';
import type { StoragePort, Visibility } from '../ports/storage.js';
import { isNotImplemented } from '../errors.js';
import { isBypassed, markPath } from '../observability/request-context.js';

/** 私有媒体 URL 的默认有效期（秒） */
export const PRIVATE_MEDIA_TTL_SEC = 600;

export function visibilityOfKey(key: string): Visibility {
  return key.startsWith('variants/') ? 'public' : 'private';
}

export interface PhotoKeys { id: string; rawKey: string; thumbKey: string | null; displayKey: string | null }
export interface PhotoUrls { thumb: string | null; display: string | null; original?: string | null }

export class MediaUrlBuilder {
  constructor(private readonly storage: StoragePort, private readonly cdn?: CdnPort) {}

  async url(key: string, opts: { visibility?: Visibility; expiresInSec?: number } = {}): Promise<string> {
    const visibility = opts.visibility ?? visibilityOfKey(key);
    const originUrl = await this.storage.createReadUrl(key, { visibility, expiresInSec: opts.expiresInSec ?? PRIVATE_MEDIA_TTL_SEC });
    const cdn = this.cdn;
    if (!cdn) return originUrl;
    if (isBypassed('cdn')) {
      markPath('cdn', `${cdn.meta.driver}:bypass`);
      return originUrl;
    }
    if (typeof cdn.mediaUrl === 'function') {
      try {
        return cdn.mediaUrl(key, { visibility, originUrl });
      } catch (e) {
        if (!isNotImplemented(e)) throw e;
      }
    }
    if (cdn.baseUrl && visibility === 'public' && originUrl.startsWith('/')) return `${cdn.baseUrl.replace(/\/+$/, '')}${originUrl}`;
    return originUrl;
  }

  async photoUrls(p: PhotoKeys, opts: { includeOriginal?: boolean } = {}): Promise<PhotoUrls> {
    const [thumb, display, original] = await Promise.all([
      p.thumbKey ? this.url(p.thumbKey, { visibility: 'public' }) : Promise.resolve(null),
      p.displayKey ? this.url(p.displayKey, { visibility: 'public' }) : Promise.resolve(null),
      opts.includeOriginal ? this.url(p.rawKey, { visibility: 'private' }) : Promise.resolve(undefined),
    ]);
    return { thumb, display, ...(original !== undefined ? { original } : {}) };
  }
}

const builders = new WeakMap<object, MediaUrlBuilder>();

/** 每个容器一个 MediaUrlBuilder（c.storage / c.cdn 已经过 instrument 代理） */
export function mediaUrls(c: { storage: StoragePort; cdn?: CdnPort }): MediaUrlBuilder {
  let b = builders.get(c);
  if (!b) {
    b = new MediaUrlBuilder(c.storage, c.cdn);
    builders.set(c, b);
  }
  return b;
}
