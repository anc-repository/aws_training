// backend/src/adapters/storage/s3.ts —— StoragePort 的 `s3` 驱动（Amazon S3）
// 原图桶 / 媒体桶；预签名 PUT / GET（进程内复用）；importObject = CopyObject
// 脚手架桩：方法抛出 NotImplementedError（HTTP 层映射为 501）。由「storage 模块实现者」填充。
import type { Readable } from 'node:stream';
import type { AdapterDeps } from '../types.js';
import type { AdapterMeta, Page, ProbeResult } from '../../ports/common.js';
import type { ObjectInfo, StoragePort, StoredObject, UploadTarget, Visibility } from '../../ports/storage.js';
import { notImplemented } from '../../errors.js';

export class S3Storage implements StoragePort {
  readonly meta: AdapterMeta = { module: 'storage', driver: 's3', awsService: 'Amazon S3', authoritative: true };

  constructor(protected readonly deps: AdapterDeps) {}

  async probe(_opts?: { deep?: boolean }): Promise<ProbeResult> {
    throw notImplemented('S3Storage', 'probe', 'storage');
  }

  async createUploadTarget(_input: { key: string; contentType: string; maxBytes: number; expiresInSec: number; metadata?: Record<string, string> }): Promise<UploadTarget> {
    throw notImplemented('S3Storage', 'createUploadTarget', 'storage');
  }

  async putObject(_key: string, _body: Buffer | Readable, _opts: { contentType: string; cacheControl?: string; metadata?: Record<string, string> }): Promise<void> {
    throw notImplemented('S3Storage', 'putObject', 'storage');
  }

  async getObject(_key: string): Promise<{ info: ObjectInfo; body: Readable }> {
    throw notImplemented('S3Storage', 'getObject', 'storage');
  }

  async headObject(_key: string): Promise<ObjectInfo | null> {
    throw notImplemented('S3Storage', 'headObject', 'storage');
  }

  async deleteObjects(_keys: string[]): Promise<void> {
    throw notImplemented('S3Storage', 'deleteObjects', 'storage');
  }

  async list(_prefix: string, _cursor?: string): Promise<Page<ObjectInfo>> {
    throw notImplemented('S3Storage', 'list', 'storage');
  }

  async createReadUrl(_key: string, _opts: { visibility: Visibility; expiresInSec: number }): Promise<string> {
    throw notImplemented('S3Storage', 'createReadUrl', 'storage');
  }

  internalRedirectPath(_key: string, _visibility: Visibility): string | null {
    throw notImplemented('S3Storage', 'internalRedirectPath', 'storage');
  }

  async count(): Promise<number> {
    throw notImplemented('S3Storage', 'count', 'storage');
  }

  async exportBatch(_cursor?: string, _limit?: number): Promise<{ items: StoredObject[]; next?: string }> {
    throw notImplemented('S3Storage', 'exportBatch', 'storage');
  }

  async importBatch(_items: StoredObject[]): Promise<{ written: number; skipped: number }> {
    throw notImplemented('S3Storage', 'importBatch', 'storage');
  }

  async importObject(_source: { bucket: string; key: string }, _destKey: string): Promise<ObjectInfo> {
    throw notImplemented('S3Storage', 'importObject', 'storage');
  }
}
