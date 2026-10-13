// backend/src/adapters/storage/s3.ts —— StoragePort 的 `s3` 驱动（Amazon S3，03#storage 第 2 节）
//
// - 两个桶：原图桶（raw/、lab/、_probe/ 与其他前缀）与展示桶（variants/、reports/）；键不变，只按前缀选桶。
// - 上传：预签名 PUT（Content-Type 与 x-amz-meta-* 纳入签名，浏览器必须按 UploadTarget.headers 原样携带）；字节不经 EC2。
// - 读取：预签名 GET；同一键的 URL 在进程内复用 STORAGE_S3_URL_REUSE_SEC（必须小于 GET 有效期），不回拨签名时间。
// - importObject：服务端 CopyObject（identity-pool 暂存桶 → 原图键，F14），路径头 storage=s3:import。
// - F14 本地前缀令牌在 s3 下的分片辅助：CreateMultipartUpload / 预签名 UploadPart / Complete / Abort / ListParts。
// - 权威端口：S3 故障一律抛出（HTTP 层 503），绝不回退到本地磁盘。
// SDK 全部经 adapters/aws/clients.ts 懒加载，L0 不会加载本文件。
import { hostname } from 'node:os';
import { Readable } from 'node:stream';
import type { S3Client } from '@aws-sdk/client-s3';
import { HttpError } from '../../errors.js';
import { markPath } from '../../observability/request-context.js';
import type { AdapterMeta, Page, ProbeResult } from '../../ports/common.js';
import type { ObjectInfo, StoragePort, StoredObject, UploadTarget, Visibility } from '../../ports/storage.js';
import { describeAwsError, isAwsAccessDenied, isAwsNotFound, loadAwsPackage } from '../aws/clients.js';
import type { AdapterDeps } from '../types.js';

type S3Config = Extract<AdapterDeps['cfg']['storage'], { STORAGE_DRIVER: 's3' }>;
type S3Sdk = typeof import('@aws-sdk/client-s3');
type Presigner = typeof import('@aws-sdk/s3-request-presigner');

/** 展示桶前缀：衍生图与日报。其余前缀（raw/、lab/、_probe/ …）都在原图桶。 */
const MEDIA_PREFIXES = ['variants/', 'reports/'] as const;
/** 预签名 URL 的最长有效期（SigV4 上限 7 天） */
const MAX_PRESIGN_SEC = 604_800;
/** 进程内 URL 复用表的上限（超出时淘汰最早的条目） */
const URL_CACHE_LIMIT = 5000;
/** 流式 putObject 在没有 @aws-sdk/lib-storage 时先缓冲到内存；超过此大小拒绝（原图上限 30 MB） */
const MAX_BUFFERED_PUT_BYTES = 64 * 1024 * 1024;

const CONTENT_TYPES: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
  csv: 'text/csv', json: 'application/json', txt: 'text/plain',
};

export function contentTypeFromKey(key: string): string {
  const ext = /\.([a-z0-9]+)$/i.exec(key)?.[1]?.toLowerCase();
  return (ext && CONTENT_TYPES[ext]) || 'application/octet-stream';
}

/** S3 的 CopySource 需要 URL 编码键（保留路径分隔符） */
function copySource(bucket: string, key: string): string {
  return `${bucket}/${key.split('/').map(encodeURIComponent).join('/')}`;
}

async function toBuffer(body: Buffer | Readable): Promise<Buffer> {
  if (Buffer.isBuffer(body)) return body;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of body) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += b.length;
    if (size > MAX_BUFFERED_PUT_BYTES) throw new HttpError(413, 'OBJECT_TOO_LARGE', `对象超过 ${MAX_BUFFERED_PUT_BYTES} 字节`);
    chunks.push(b);
  }
  return Buffer.concat(chunks);
}

function asReadable(body: unknown): Readable {
  if (body instanceof Readable) return body;
  if (body && typeof (body as AsyncIterable<unknown>)[Symbol.asyncIterator] === 'function') return Readable.from(body as AsyncIterable<unknown>);
  if (Buffer.isBuffer(body) || body instanceof Uint8Array) return Readable.from([Buffer.from(body)]);
  if (typeof body === 'string') return Readable.from([Buffer.from(body)]);
  throw new Error('S3 GetObject 返回了无法识别的 Body 类型');
}

/** S3 / 网络故障 → 503（权威端口不回退）；参数错误保持原样 */
function unavailable(op: string, e: unknown): Error {
  if (e instanceof HttpError) return e;
  return new HttpError(503, 'STORAGE_UNAVAILABLE', `S3 ${op} 失败：${describeAwsError(e)}`, { module: 'storage', driver: 's3' });
}

export interface MultipartPart { partNumber: number; etag: string; size?: number }

export class S3Storage implements StoragePort {
  readonly meta: AdapterMeta = { module: 'storage', driver: 's3', awsService: 'Amazon S3', authoritative: true };

  private readonly s3cfg: S3Config;
  private sdkPromise?: Promise<S3Sdk>;
  private presignerPromise?: Promise<Presigner>;
  /** 读取 URL 复用表：`<visibility>|<expiresIn>|<key>` → URL 与签发时间 */
  private readonly urlCache = new Map<string, { url: string; signedAt: number; expiresAt: number }>();

  constructor(protected readonly deps: AdapterDeps) {
    const storage = deps.cfg.storage;
    if (storage.STORAGE_DRIVER !== 's3') throw new Error(`S3Storage 需要 STORAGE_DRIVER=s3（当前 ${storage.STORAGE_DRIVER}）`);
    this.s3cfg = storage;
  }

  get rawBucket(): string {
    return this.s3cfg.STORAGE_S3_RAW_BUCKET;
  }

  get mediaBucket(): string {
    return this.s3cfg.STORAGE_S3_MEDIA_BUCKET;
  }

  /** 逻辑键 → 桶（variants/、reports/ 在展示桶，其余在原图桶） */
  bucketFor(key: string): string {
    return MEDIA_PREFIXES.some((p) => key.startsWith(p)) ? this.mediaBucket : this.rawBucket;
  }

  private client(): Promise<S3Client> {
    return this.deps.aws.s3();
  }

  private sdk(): Promise<S3Sdk> {
    this.sdkPromise ??= loadAwsPackage('@aws-sdk/client-s3', () => import('@aws-sdk/client-s3'));
    return this.sdkPromise;
  }

  private presigner(): Promise<Presigner> {
    this.presignerPromise ??= loadAwsPackage('@aws-sdk/s3-request-presigner', () => import('@aws-sdk/s3-request-presigner'));
    return this.presignerPromise;
  }

  // ------------------------------------------------------------------------------------------
  // 探针（总纲 6.2；03#storage 第 10 节）
  // ------------------------------------------------------------------------------------------
  async probe(opts: { deep?: boolean } = {}): Promise<ProbeResult> {
    const t0 = performance.now();
    const { HeadBucketCommand } = await this.sdk();
    let s3: S3Client;
    try {
      s3 = await this.client();
    } catch (e) {
      return { status: 'error', detail: `无法创建 S3 客户端：${(e as Error).message}`, confidence: 'confirmed' };
    }
    const buckets = [this.rawBucket, this.mediaBucket];
    const results = await Promise.all(buckets.map(async (Bucket) => {
      try {
        await s3.send(new HeadBucketCommand({ Bucket }));
        return { bucket: Bucket, ok: true as const };
      } catch (e) {
        return { bucket: Bucket, ok: false as const, error: e };
      }
    }));
    const latencyMs = Math.round((performance.now() - t0) * 10) / 10;
    const failed = results.filter((r) => !r.ok);
    if (failed.length) {
      const reason = failed.map((f) => {
        const err = (f as { error: unknown }).error;
        const kind = isAwsNotFound(err) ? '桶不存在' : isAwsAccessDenied(err) ? '无权限（检查 PolicyArn 的 s3:ListBucket）' : describeAwsError(err);
        return `${f.bucket}：${kind}`;
      }).join('；');
      return { status: 'error', detail: `HeadBucket 失败 · ${reason}`, latencyMs, confidence: 'confirmed', data: { buckets } };
    }
    const data: Record<string, unknown> = { rawBucket: this.rawBucket, mediaBucket: this.mediaBucket, region: this.deps.aws.region };
    let status: ProbeResult['status'] = latencyMs > 1000 ? 'degraded' : 'ok';
    let detail = `HeadBucket 200 ×2（raw / media）· ${latencyMs}ms`;
    if (latencyMs > 1000) detail += ' · 延迟 > 1s';
    if (opts.deep) {
      const deep = await this.deepProbe(s3);
      Object.assign(data, deep.data);
      detail += ` · ${deep.detail}`;
      if (deep.status === 'error') status = 'error';
      else if (deep.status === 'degraded' && status === 'ok') status = 'degraded';
    }
    return { status, detail, latencyMs, confidence: 'confirmed', data };
  }

  /** 深度探针：签发预签名 PUT → 写 1 KB `_probe/<instanceId>` → HeadObject → 删除；GetBucketEncryption 比对 KMS_KEY_ID */
  private async deepProbe(s3: S3Client): Promise<{ status: ProbeResult['status']; detail: string; data: Record<string, unknown> }> {
    const { GetBucketEncryptionCommand } = await this.sdk();
    const key = `_probe/${hostname()}-${process.pid}-${Date.now()}`;
    const steps: string[] = [];
    try {
      await this.createUploadTarget({ key, contentType: 'application/octet-stream', maxBytes: 1024, expiresInSec: 60 });
      steps.push('presign');
      await this.putObject(key, Buffer.alloc(1024, 0x61), { contentType: 'application/octet-stream' });
      steps.push('put');
      const head = await this.headObject(key);
      if (!head || head.size !== 1024) throw new Error(`HeadObject 结果不符：${JSON.stringify(head)}`);
      steps.push('head');
      await this.deleteObjects([key]);
      steps.push('delete');
    } catch (e) {
      return { status: 'error', detail: `写-读-删失败（已完成：${steps.join(' → ') || '无'}）：${(e as Error).message}`, data: { deepSteps: steps } };
    }
    const expectKms = Boolean(this.deps.cfg.core.KMS_KEY_ID);
    const encryption: Record<string, string> = {};
    let mismatch = false;
    for (const Bucket of [this.rawBucket, this.mediaBucket]) {
      try {
        const r = await s3.send(new GetBucketEncryptionCommand({ Bucket }));
        const algo = r.ServerSideEncryptionConfiguration?.Rules?.[0]?.ApplyServerSideEncryptionByDefault?.SSEAlgorithm ?? 'none';
        encryption[Bucket] = algo;
        if (expectKms !== String(algo).startsWith('aws:kms')) mismatch = true;
      } catch (e) {
        encryption[Bucket] = `unknown（${describeAwsError(e)}）`;
      }
    }
    const encDetail = Object.values(encryption).join(' / ');
    return {
      status: mismatch ? 'degraded' : 'ok',
      detail: `写-读-删 1 KB 通过 · 默认加密 ${encDetail}${mismatch ? `（与 KMS_KEY_ID${expectKms ? '' : '=空'} 不一致：kms 注入后栈未更新？）` : ''}`,
      data: { deepSteps: steps, encryption },
    };
  }

  // ------------------------------------------------------------------------------------------
  // 上传与写入
  // ------------------------------------------------------------------------------------------
  async createUploadTarget(input: { key: string; contentType: string; maxBytes: number; expiresInSec: number; metadata?: Record<string, string> }): Promise<UploadTarget> {
    const { PutObjectCommand } = await this.sdk();
    const { getSignedUrl } = await this.presigner();
    const expiresIn = this.clampExpiry(input.expiresInSec, this.s3cfg.STORAGE_S3_PRESIGN_TTL_SEC);
    const metadata = normalizeMetadata(input.metadata);
    const metaHeaders = Object.keys(metadata).map((k) => `x-amz-meta-${k}`);
    try {
      const s3 = await this.client();
      const url = await getSignedUrl(s3, new PutObjectCommand({
        Bucket: this.bucketFor(input.key), Key: input.key, ContentType: input.contentType,
        ...(metaHeaders.length ? { Metadata: metadata } : {}),
      }), {
        expiresIn,
        // Content-Type 与 x-amz-meta-* 都纳入签名，且 x-amz-meta-* 留在请求头（不提升到查询串）：浏览器必须原样携带
        signableHeaders: new Set(['content-type', ...metaHeaders]),
        unhoistableHeaders: new Set(metaHeaders),
      });
      markPath('storage', 's3:presign');
      const headers: Record<string, string> = { 'Content-Type': input.contentType };
      for (const [k, v] of Object.entries(metadata)) headers[`x-amz-meta-${k}`] = v;
      return { method: 'PUT', url, headers, expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString() };
    } catch (e) {
      throw unavailable('presign PUT', e);
    }
  }

  async putObject(key: string, body: Buffer | Readable, opts: { contentType: string; cacheControl?: string; metadata?: Record<string, string> }): Promise<void> {
    const { PutObjectCommand } = await this.sdk();
    const buf = await toBuffer(body);
    const cacheControl = opts.cacheControl ?? (key.startsWith('variants/') ? 'public, max-age=31536000, immutable' : undefined);
    const metadata = normalizeMetadata(opts.metadata);
    try {
      const s3 = await this.client();
      await s3.send(new PutObjectCommand({
        Bucket: this.bucketFor(key), Key: key, Body: buf, ContentLength: buf.length, ContentType: opts.contentType,
        ...(cacheControl ? { CacheControl: cacheControl } : {}),
        ...(Object.keys(metadata).length ? { Metadata: metadata } : {}),
      }));
    } catch (e) {
      throw unavailable('PutObject', e);
    }
  }

  // ------------------------------------------------------------------------------------------
  // 读取
  // ------------------------------------------------------------------------------------------
  async getObject(key: string): Promise<{ info: ObjectInfo; body: Readable }> {
    const { GetObjectCommand } = await this.sdk();
    try {
      const s3 = await this.client();
      const r = await s3.send(new GetObjectCommand({ Bucket: this.bucketFor(key), Key: key }));
      return {
        info: {
          key,
          size: Number(r.ContentLength ?? 0),
          contentType: r.ContentType ?? contentTypeFromKey(key),
          ...(r.ETag ? { etag: r.ETag.replace(/"/g, '') } : {}),
          lastModified: (r.LastModified ?? new Date()).toISOString(),
          ...(r.Metadata && Object.keys(r.Metadata).length ? { metadata: r.Metadata } : {}),
        },
        body: asReadable(r.Body),
      };
    } catch (e) {
      if (isAwsNotFound(e)) throw new HttpError(404, 'OBJECT_NOT_FOUND', `对象不存在：${key}`);
      throw unavailable('GetObject', e);
    }
  }

  async headObject(key: string): Promise<ObjectInfo | null> {
    const { HeadObjectCommand } = await this.sdk();
    try {
      const s3 = await this.client();
      const r = await s3.send(new HeadObjectCommand({ Bucket: this.bucketFor(key), Key: key }));
      markPath('storage', 's3:head');
      return {
        key,
        size: Number(r.ContentLength ?? 0),
        contentType: r.ContentType ?? contentTypeFromKey(key),
        ...(r.ETag ? { etag: r.ETag.replace(/"/g, '') } : {}),
        lastModified: (r.LastModified ?? new Date()).toISOString(),
        ...(r.Metadata && Object.keys(r.Metadata).length ? { metadata: r.Metadata } : {}),
      };
    } catch (e) {
      if (isAwsNotFound(e)) {
        markPath('storage', 's3:head');
        return null;
      }
      // 缺 s3:ListBucket 时不存在的键会得到 403 而不是 404（03#storage 常见坑）：照常报错，不当作“不存在”
      throw unavailable('HeadObject', e);
    }
  }

  async deleteObjects(keys: string[]): Promise<void> {
    if (!keys.length) return;
    const { DeleteObjectsCommand } = await this.sdk();
    const byBucket = new Map<string, string[]>();
    for (const k of new Set(keys)) {
      const b = this.bucketFor(k);
      byBucket.set(b, [...(byBucket.get(b) ?? []), k]);
    }
    try {
      const s3 = await this.client();
      for (const [Bucket, list] of byBucket) {
        for (let i = 0; i < list.length; i += 1000) {
          const chunk = list.slice(i, i + 1000);
          const r = await s3.send(new DeleteObjectsCommand({ Bucket, Delete: { Objects: chunk.map((Key) => ({ Key })), Quiet: true } }));
          const errors = (r.Errors ?? []).filter((x) => x.Code !== 'NoSuchKey');
          if (errors.length) throw new Error(`DeleteObjects 部分失败：${errors.map((x) => `${x.Key}（${x.Code}）`).join(', ')}`);
        }
      }
    } catch (e) {
      throw unavailable('DeleteObjects', e);
    }
  }

  async list(prefix: string, cursor?: string): Promise<Page<ObjectInfo>> {
    const { ListObjectsV2Command } = await this.sdk();
    try {
      const s3 = await this.client();
      const r = await s3.send(new ListObjectsV2Command({
        Bucket: this.bucketFor(prefix), Prefix: prefix, MaxKeys: 1000, ...(cursor ? { ContinuationToken: cursor } : {}),
      }));
      return {
        items: (r.Contents ?? []).filter((o) => o.Key).map((o) => ({
          key: o.Key!,
          size: Number(o.Size ?? 0),
          contentType: contentTypeFromKey(o.Key!),
          ...(o.ETag ? { etag: o.ETag.replace(/"/g, '') } : {}),
          lastModified: (o.LastModified ?? new Date(0)).toISOString(),
        })),
        ...(r.IsTruncated && r.NextContinuationToken ? { next: r.NextContinuationToken } : {}),
      };
    } catch (e) {
      throw unavailable('ListObjectsV2', e);
    }
  }

  /** 源站读取地址：预签名 GET；同一键在 STORAGE_S3_URL_REUSE_SEC 内复用同一个 URL（浏览器缓存因此有效） */
  async createReadUrl(key: string, opts: { visibility: Visibility; expiresInSec: number }): Promise<string> {
    const expiresIn = this.clampExpiry(opts.expiresInSec, this.s3cfg.STORAGE_S3_GET_TTL_SEC);
    const reuseMs = Math.min(this.s3cfg.STORAGE_S3_URL_REUSE_SEC, Math.max(0, expiresIn - 30)) * 1000;
    const cacheKey = `${opts.visibility}|${expiresIn}|${key}`;
    const now = Date.now();
    const hit = this.urlCache.get(cacheKey);
    if (hit && now - hit.signedAt < reuseMs && hit.expiresAt > now) {
      markPath('storage', 's3:presign');
      return hit.url;
    }
    const { GetObjectCommand } = await this.sdk();
    const { getSignedUrl } = await this.presigner();
    try {
      const s3 = await this.client();
      const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: this.bucketFor(key), Key: key }), { expiresIn });
      markPath('storage', 's3:presign');
      if (reuseMs > 0) {
        this.urlCache.delete(cacheKey);
        this.urlCache.set(cacheKey, { url, signedAt: now, expiresAt: now + expiresIn * 1000 });
        if (this.urlCache.size > URL_CACHE_LIMIT) {
          const oldest = this.urlCache.keys().next().value;
          if (oldest !== undefined) this.urlCache.delete(oldest);
        }
      }
      return url;
    } catch (e) {
      throw unavailable('presign GET', e);
    }
  }

  /** s3 没有 X-Accel-Redirect：/media 路由改为 302 到 createReadUrl()（路径头 storage=s3:redirect 由路由标记） */
  internalRedirectPath(_key: string, _visibility: Visibility): string | null {
    return null;
  }

  // ------------------------------------------------------------------------------------------
  // F14：identity-pool 暂存桶 → 原图键（服务端 CopyObject，字节不经 EC2）
  // ------------------------------------------------------------------------------------------
  async importObject(source: { bucket: string; key: string }, destKey: string): Promise<ObjectInfo> {
    const { CopyObjectCommand } = await this.sdk();
    try {
      const s3 = await this.client();
      await s3.send(new CopyObjectCommand({
        Bucket: this.bucketFor(destKey), Key: destKey, CopySource: copySource(source.bucket, source.key), MetadataDirective: 'COPY',
      }));
    } catch (e) {
      if (isAwsNotFound(e)) throw new HttpError(404, 'OBJECT_NOT_FOUND', `暂存对象不存在：${source.bucket}/${source.key}`);
      throw unavailable('CopyObject', e);
    }
    const info = await this.headObject(destKey);
    markPath('storage', 's3:import');
    if (!info) throw new HttpError(503, 'STORAGE_UNAVAILABLE', `CopyObject 之后读不到 ${destKey}`);
    return info;
  }

  // ------------------------------------------------------------------------------------------
  // F14 本地前缀令牌在 s3 下的分片辅助（DirectUploadPort(none) 校验令牌前缀后调用；02#identity-pool）
  // ------------------------------------------------------------------------------------------
  async createMultipartUpload(key: string, opts: { contentType: string; metadata?: Record<string, string> }): Promise<{ uploadId: string }> {
    const { CreateMultipartUploadCommand } = await this.sdk();
    try {
      const s3 = await this.client();
      const r = await s3.send(new CreateMultipartUploadCommand({
        Bucket: this.bucketFor(key), Key: key, ContentType: opts.contentType,
        ...(opts.metadata ? { Metadata: normalizeMetadata(opts.metadata) } : {}),
      }));
      if (!r.UploadId) throw new Error('CreateMultipartUpload 没有返回 UploadId');
      return { uploadId: r.UploadId };
    } catch (e) {
      throw unavailable('CreateMultipartUpload', e);
    }
  }

  /** 为一片签发预签名 UploadPart URL（浏览器 PUT 该 URL，响应头 ETag 需要 CORS ExposedHeaders） */
  async presignUploadPart(key: string, uploadId: string, partNumber: number, expiresInSec: number): Promise<{ url: string; expiresAt: string }> {
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10_000) throw new HttpError(400, 'INVALID_PART', 'partNumber 必须是 1～10000 的整数');
    const { UploadPartCommand } = await this.sdk();
    const { getSignedUrl } = await this.presigner();
    const expiresIn = this.clampExpiry(expiresInSec, this.s3cfg.STORAGE_S3_PRESIGN_TTL_SEC);
    try {
      const s3 = await this.client();
      const url = await getSignedUrl(s3, new UploadPartCommand({ Bucket: this.bucketFor(key), Key: key, UploadId: uploadId, PartNumber: partNumber }), { expiresIn });
      markPath('storage', 's3:presign');
      return { url, expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString() };
    } catch (e) {
      throw unavailable('presign UploadPart', e);
    }
  }

  async listParts(key: string, uploadId: string): Promise<MultipartPart[]> {
    const { ListPartsCommand } = await this.sdk();
    const parts: MultipartPart[] = [];
    try {
      const s3 = await this.client();
      let marker: string | undefined;
      do {
        const r = await s3.send(new ListPartsCommand({ Bucket: this.bucketFor(key), Key: key, UploadId: uploadId, ...(marker ? { PartNumberMarker: marker } : {}) }));
        for (const p of r.Parts ?? []) {
          if (p.PartNumber && p.ETag) parts.push({ partNumber: p.PartNumber, etag: p.ETag, ...(p.Size !== undefined ? { size: Number(p.Size) } : {}) });
        }
        marker = r.IsTruncated ? r.NextPartNumberMarker : undefined;
      } while (marker);
      return parts;
    } catch (e) {
      if (isAwsNotFound(e)) throw new HttpError(404, 'UPLOAD_NOT_FOUND', `分片上传不存在：${uploadId}`);
      throw unavailable('ListParts', e);
    }
  }

  async completeMultipartUpload(key: string, uploadId: string, parts: MultipartPart[]): Promise<ObjectInfo> {
    const { CompleteMultipartUploadCommand } = await this.sdk();
    const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);
    try {
      const s3 = await this.client();
      await s3.send(new CompleteMultipartUploadCommand({
        Bucket: this.bucketFor(key), Key: key, UploadId: uploadId,
        MultipartUpload: { Parts: sorted.map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })) },
      }));
    } catch (e) {
      if (isAwsNotFound(e)) throw new HttpError(404, 'UPLOAD_NOT_FOUND', `分片上传不存在：${uploadId}`);
      throw unavailable('CompleteMultipartUpload', e);
    }
    const info = await this.headObject(key);
    if (!info) throw new HttpError(503, 'STORAGE_UNAVAILABLE', `CompleteMultipartUpload 之后读不到 ${key}`);
    return info;
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    const { AbortMultipartUploadCommand } = await this.sdk();
    try {
      const s3 = await this.client();
      await s3.send(new AbortMultipartUploadCommand({ Bucket: this.bucketFor(key), Key: key, UploadId: uploadId }));
    } catch (e) {
      if (isAwsNotFound(e)) return;
      throw unavailable('AbortMultipartUpload', e);
    }
  }

  // ------------------------------------------------------------------------------------------
  // Migratable<StoredObject>（scripts/migrate/storage 的 copyViaPorts：local ↔ s3，键不变）
  // ------------------------------------------------------------------------------------------
  async count(): Promise<number> {
    const { ListObjectsV2Command } = await this.sdk();
    let total = 0;
    try {
      const s3 = await this.client();
      for (const Bucket of this.buckets()) {
        let token: string | undefined;
        do {
          const r = await s3.send(new ListObjectsV2Command({ Bucket, MaxKeys: 1000, ...(token ? { ContinuationToken: token } : {}) }));
          total += (r.Contents ?? []).filter((o) => o.Key && !o.Key.startsWith('_probe/')).length;
          token = r.IsTruncated ? r.NextContinuationToken : undefined;
        } while (token);
      }
      return total;
    } catch (e) {
      throw unavailable('ListObjectsV2', e);
    }
  }

  private buckets(): string[] {
    return this.rawBucket === this.mediaBucket ? [this.rawBucket] : [this.rawBucket, this.mediaBucket];
  }

  /** 游标 = base64url(JSON{ b: 桶序号, t: ContinuationToken })；先原图桶后展示桶。_probe/ 不导出。 */
  async exportBatch(cursor?: string, limit = 100): Promise<{ items: StoredObject[]; next?: string }> {
    const { ListObjectsV2Command } = await this.sdk();
    const pos = cursor ? (JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { b: number; t?: string }) : { b: 0 };
    const buckets = this.buckets();
    const Bucket = buckets[pos.b];
    if (!Bucket) return { items: [] };
    let r;
    try {
      const s3 = await this.client();
      r = await s3.send(new ListObjectsV2Command({ Bucket, MaxKeys: Math.max(1, Math.min(1000, limit)), ...(pos.t ? { ContinuationToken: pos.t } : {}) }));
    } catch (e) {
      throw unavailable('ListObjectsV2', e);
    }
    const keys = (r.Contents ?? []).map((o) => o.Key).filter((k): k is string => Boolean(k) && !k!.startsWith('_probe/'));
    const infos = await mapLimit(keys, 8, async (key) => this.headObject(key));
    const items: StoredObject[] = infos.filter((i): i is ObjectInfo => i !== null).map((info) => ({
      info,
      body: async () => (await this.getObject(info.key)).body,
    }));
    let next: string | undefined;
    if (r.IsTruncated && r.NextContinuationToken) next = encodeCursor({ b: pos.b, t: r.NextContinuationToken });
    else if (pos.b + 1 < buckets.length) next = encodeCursor({ b: pos.b + 1 });
    return { items, ...(next ? { next } : {}) };
  }

  /** 幂等：目标已存在且大小一致则跳过 */
  async importBatch(items: StoredObject[]): Promise<{ written: number; skipped: number }> {
    let written = 0;
    let skipped = 0;
    for (const item of items) {
      const existing = await this.headObject(item.info.key);
      if (existing && existing.size === item.info.size) {
        skipped += 1;
        continue;
      }
      const body = await item.body();
      await this.putObject(item.info.key, body, {
        contentType: item.info.contentType || contentTypeFromKey(item.info.key),
        ...(item.info.metadata ? { metadata: item.info.metadata } : {}),
      });
      written += 1;
    }
    return { written, skipped };
  }

  private clampExpiry(requested: number, fallback: number): number {
    const v = Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : fallback;
    return Math.max(1, Math.min(v, MAX_PRESIGN_SEC));
  }
}

/** S3 用户元数据：键小写、只保留 [a-z0-9-]，值转为 ASCII 可打印（HTTP 头的限制） */
function normalizeMetadata(meta: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(meta ?? {})) {
    const key = k.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    if (!key) continue;
    out[key] = String(v).replace(/[^\x20-\x7e]/g, '?');
  }
  return out;
}

function encodeCursor(c: { b: number; t?: string }): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]!);
    }
  });
  await Promise.all(workers);
  return out;
}
