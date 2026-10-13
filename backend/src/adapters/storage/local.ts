// backend/src/adapters/storage/local.ts —— StoragePort 的 `local` 驱动（本地实现）
// STORAGE_LOCAL_ROOT 下按逻辑键存放；HMAC 签名 URL（upload-hmac-key / media-hmac-key）；.incoming → fsync → rename；X-Accel-Redirect
// 脚手架桩：方法抛出 NotImplementedError（HTTP 层映射为 501）。由「L0 本地实现者」填充。
import type { Readable } from 'node:stream';
import type { AdapterDeps } from '../types.js';
import type { AdapterMeta, Page, ProbeResult } from '../../ports/common.js';
import type { ModuleId } from '@cloudalbum/contracts';
import type { ObjectInfo, StoragePort, StoredObject, UploadTarget, Visibility } from '../../ports/storage.js';
import { notImplemented } from '../../errors.js';
import { storageLocalRoot } from '../../config/schema.js';

/** shared-fs 的 efs 驱动复用本类，只换根目录与元数据（总纲 4.5） */
export interface LocalStorageOptions {
  root: string;
  module: Extract<ModuleId, 'storage' | 'shared-fs'>;
  driver: 'local' | 'efs';
  awsService: string | null;
  /** X-Accel-Redirect 内部 location 前缀：/_media_local 或 /_media_efs */
  redirectPrefix: '/_media_local' | '/_media_efs';
  /** efs：探针校验该路径确实是 nfs4 挂载（防止悄悄写到 EBS 上） */
  requireMountType?: 'nfs4';
}

export class LocalStorage implements StoragePort {
  readonly meta: AdapterMeta;

  constructor(
    protected readonly deps: AdapterDeps,
    protected readonly options: LocalStorageOptions = {
      root: storageLocalRoot(deps.cfg), module: 'storage', driver: 'local', awsService: null, redirectPrefix: '/_media_local',
    },
  ) {
    this.meta = { module: options.module, driver: options.driver, awsService: options.awsService, authoritative: true };
  }

  async probe(_opts?: { deep?: boolean }): Promise<ProbeResult> {
    throw notImplemented('LocalStorage', 'probe', 'storage');
  }

  async createUploadTarget(_input: { key: string; contentType: string; maxBytes: number; expiresInSec: number; metadata?: Record<string, string> }): Promise<UploadTarget> {
    throw notImplemented('LocalStorage', 'createUploadTarget', 'storage');
  }

  async putObject(_key: string, _body: Buffer | Readable, _opts: { contentType: string; cacheControl?: string; metadata?: Record<string, string> }): Promise<void> {
    throw notImplemented('LocalStorage', 'putObject', 'storage');
  }

  async getObject(_key: string): Promise<{ info: ObjectInfo; body: Readable }> {
    throw notImplemented('LocalStorage', 'getObject', 'storage');
  }

  async headObject(_key: string): Promise<ObjectInfo | null> {
    throw notImplemented('LocalStorage', 'headObject', 'storage');
  }

  async deleteObjects(_keys: string[]): Promise<void> {
    throw notImplemented('LocalStorage', 'deleteObjects', 'storage');
  }

  async list(_prefix: string, _cursor?: string): Promise<Page<ObjectInfo>> {
    throw notImplemented('LocalStorage', 'list', 'storage');
  }

  async createReadUrl(_key: string, _opts: { visibility: Visibility; expiresInSec: number }): Promise<string> {
    throw notImplemented('LocalStorage', 'createReadUrl', 'storage');
  }

  internalRedirectPath(_key: string, _visibility: Visibility): string | null {
    throw notImplemented('LocalStorage', 'internalRedirectPath', 'storage');
  }

  async count(): Promise<number> {
    throw notImplemented('LocalStorage', 'count', 'storage');
  }

  async exportBatch(_cursor?: string, _limit?: number): Promise<{ items: StoredObject[]; next?: string }> {
    throw notImplemented('LocalStorage', 'exportBatch', 'storage');
  }

  async importBatch(_items: StoredObject[]): Promise<{ written: number; skipped: number }> {
    throw notImplemented('LocalStorage', 'importBatch', 'storage');
  }
}
