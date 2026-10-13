// backend/src/ports/storage.ts （总纲 §4.2，照录）
import type { Readable } from 'node:stream';
import type { Adapter, Migratable, Page } from './common.js';

export type Visibility = 'public' | 'private';
export interface ObjectInfo {
  key: string; size: number; contentType: string; etag?: string; lastModified: string;
  metadata?: Record<string, string>;
}
export interface UploadTarget {
  method: 'PUT';
  url: string;                       // local: /api/storage/upload?key=&ct=&max=&exp=&sig=   s3: 预签名 URL
  headers: Record<string, string>;   // 浏览器必须原样携带（Content-Type、x-amz-meta-*）
  expiresAt: string;
}
export interface StoredObject { info: ObjectInfo; body: () => Promise<Readable> }

export interface StoragePort extends Adapter, Migratable<StoredObject> {
  createUploadTarget(input: {
    key: string; contentType: string; maxBytes: number; expiresInSec: number;
    metadata?: Record<string, string>;
  }): Promise<UploadTarget>;
  putObject(key: string, body: Buffer | Readable,
            opts: { contentType: string; cacheControl?: string; metadata?: Record<string, string> }): Promise<void>;
  getObject(key: string): Promise<{ info: ObjectInfo; body: Readable }>;
  headObject(key: string): Promise<ObjectInfo | null>;
  deleteObjects(keys: string[]): Promise<void>;
  list(prefix: string, cursor?: string): Promise<Page<ObjectInfo>>;
  /** 源站读取地址（local: 带 HMAC 的 /media/...；s3: 预签名 GET）。CDN 改写由 MediaUrlBuilder 负责，不在端口里 */
  createReadUrl(key: string, opts: { visibility: Visibility; expiresInSec: number }): Promise<string>;
  /** local/efs 返回 X-Accel-Redirect 内部路径；s3 返回 null（/media 路由改为 302 到 createReadUrl） */
  internalRedirectPath(key: string, visibility: Visibility): string | null;
  /** 仅 s3 驱动实现：服务端 CopyObject，把 identity-pool 暂存桶中的对象导入原图键（F14 的 complete 阶段） */
  importObject?(source: { bucket: string; key: string }, destKey: string): Promise<ObjectInfo>;
}
// 原图键 raw/<userId>/<photoId>.<ext>，衍生图键 variants/<photoId>/thumb_200.webp、display_1080.webp，日报 reports/daily/；
// 临时文件写在 uploads/.incoming/ 后 rename；s3 的 GET 预签名有效期 STORAGE_S3_GET_TTL_SEC，同键 URL 在进程内复用
// STORAGE_S3_URL_REUSE_SEC（必须小于 GET TTL），不回拨签名时间。
