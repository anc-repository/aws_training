// backend/src/adapters/identity-pool/none.ts —— DirectUploadPort 的 `none` 驱动（本地实现，02#identity-pool 第 1 节）
//
// F14 应用自签的前缀范围上传令牌（密钥 = SecretsPort 的 upload-hmac-key，与 F6 签名 URL 同一把）：
//   令牌 = base64url(JSON{v:1, uid, prefix:"raw/<userId>/", exp, maxFiles, maxBytesPerFile, jti}) + "." + base64url(HMAC-SHA256)；
//   浏览器持有一个令牌（不是每个文件一个 URL），每个文件先 POST /api/photos 建档，键为 raw/<userId>/<photoId>.<ext>。
// - authorizePart：校验签名、有效期、键在令牌前缀之内、键对应的照片属于令牌主人且状态为 UPLOADING；
//   storage=local 时分片由 uploads 路由写到 uploads/.incoming/<uploadId>/；storage=s3 时为这一片签发预签名 UploadPart URL
//   （分片上传由后端代为创建，约定 uploadId = photoId，S3 的 UploadId 记在本进程内存中）。
// - complete：合并分片（local：拼接 .incoming/<uploadId>/；s3：ListParts + CompleteMultipartUpload），然后由 PhotoPipeline 校验与处理。
// 撤销靠 jti 黑名单（未实现：令牌有效期 IDENTITY_TOKEN_TTL_SEC，默认 15 分钟）。
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { access, mkdir } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import type { AdapterDeps } from '../types.js';
import type { AdapterMeta, ProbeResult } from '../../ports/common.js';
import type { DirectUploadPort, DirectUploadSession } from '../../ports/direct-upload.js';
import type { Principal } from '../../ports/auth.js';
import type { StoragePort } from '../../ports/storage.js';
import { storageLocalRoot } from '../../config/schema.js';
import { HttpError } from '../../errors.js';
import { currentContext, markPath } from '../../observability/request-context.js';
import { DEFAULT_RUNTIME_CONFIG } from '../../ports/config.js';
import { getPhoto } from '../../repositories/photos.js';
import { asLocalMultipart } from '../storage/local.js';

const MB = 1024 * 1024;
/** 一个令牌最多覆盖的文件数（写进令牌，供前端提示；服务端按“属于本人、UPLOADING 的照片”校验） */
export const TOKEN_MAX_FILES = 50;

export interface UploadTokenPayload {
  v: 1;
  uid: string;
  prefix: string;
  exp: number;
  maxFiles: number;
  maxBytesPerFile: number;
  jti: string;
}

interface S3Multipart {
  createMultipartUpload(key: string, opts: { contentType: string; metadata?: Record<string, string> }): Promise<{ uploadId: string }>;
  presignUploadPart(key: string, uploadId: string, partNumber: number, expiresInSec: number): Promise<{ url: string; expiresAt: string }>;
  listParts(key: string, uploadId: string): Promise<Array<{ partNumber: number; etag: string; size?: number }>>;
  completeMultipartUpload(key: string, uploadId: string, parts: Array<{ partNumber: number; etag: string }>): Promise<unknown>;
}

function asS3Multipart(s: StoragePort): (StoragePort & S3Multipart) | null {
  const x = s as Partial<S3Multipart>;
  return typeof x.presignUploadPart === 'function' && typeof x.createMultipartUpload === 'function' && typeof x.completeMultipartUpload === 'function'
    ? (s as StoragePort & S3Multipart) : null;
}

function b64(s: string | Buffer): string {
  return Buffer.from(s).toString('base64url');
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

const KEY_RE = /^raw\/([^/]+)\/([0-9a-f-]{36})\.(jpg|png|webp)$/i;

export class PrefixTokenUpload implements DirectUploadPort {
  readonly meta: AdapterMeta = { module: 'identity-pool', driver: 'none', awsService: null, authoritative: false };
  /** storage=s3：photoId → S3 UploadId（单实例内存；多实例时由 identity-pool=cognito 承担 F14） */
  private readonly s3Uploads = new Map<string, string>();

  constructor(protected readonly deps: AdapterDeps) {}

  private storage(): StoragePort {
    const s = this.deps.storage;
    if (!s) throw new Error('PrefixTokenUpload: 缺少依赖 storage（container 装配顺序错误）');
    return s;
  }

  private async key(): Promise<string> {
    const secrets = this.deps.secrets;
    if (!secrets) throw new HttpError(503, 'SECRETS_UNAVAILABLE', 'SecretsPort 不可用');
    const k = await secrets.get('upload-hmac-key');
    if (!k) throw new HttpError(503, 'UPLOAD_KEY_MISSING', 'upload-hmac-key 未配置');
    return k;
  }

  private maxBytes(): number {
    let mb = DEFAULT_RUNTIME_CONFIG.maxUploadMb;
    try {
      mb = this.deps.runtime?.current().maxUploadMb ?? mb;
    } catch {
      /* 运行时配置不可读：用默认值 */
    }
    return Math.floor(mb * MB);
  }

  private partSize(): number {
    return this.deps.cfg.identity.IDENTITY_PART_SIZE_MB * MB;
  }

  async sign(payload: UploadTokenPayload): Promise<string> {
    const body = b64(JSON.stringify(payload));
    const sig = createHmac('sha256', await this.key()).update(`ca-upload.v1.${body}`).digest('base64url');
    return `${body}.${sig}`;
  }

  /** 校验令牌；失败抛 401 / 403 */
  async verify(token: string, now = Date.now()): Promise<UploadTokenPayload> {
    const [body, sig] = token.split('.');
    if (!body || !sig) throw new HttpError(401, 'UPLOAD_TOKEN_INVALID', '上传令牌格式错误');
    const expected = createHmac('sha256', await this.key()).update(`ca-upload.v1.${body}`).digest('base64url');
    if (!safeEqual(sig, expected)) throw new HttpError(401, 'UPLOAD_TOKEN_INVALID', '上传令牌签名无效');
    let p: UploadTokenPayload;
    try {
      p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as UploadTokenPayload;
    } catch {
      throw new HttpError(401, 'UPLOAD_TOKEN_INVALID', '上传令牌无法解析');
    }
    if (p.v !== 1 || !p.uid || !p.prefix) throw new HttpError(401, 'UPLOAD_TOKEN_INVALID', '上传令牌字段不完整');
    if (p.exp * 1000 < now) throw new HttpError(401, 'UPLOAD_TOKEN_EXPIRED', '上传令牌已过期，请重新开会话（POST /api/uploads/session）');
    return p;
  }

  async probe(opts: { deep?: boolean } = {}): Promise<ProbeResult> {
    const problems: string[] = [];
    let status: ProbeResult['status'] = 'ok';
    try {
      await this.key();
    } catch (e) {
      return { status: 'error', detail: `upload-hmac-key 不可读：${(e as Error).message}`, confidence: 'confirmed' };
    }
    if (this.deps.cfg.storage.STORAGE_DRIVER !== 's3') {
      const dir = path.join(storageLocalRoot(this.deps.cfg), '.incoming');
      try {
        await mkdir(dir, { recursive: true });
        await access(dir, fsConstants.W_OK);
      } catch (e) {
        status = 'error';
        problems.push(`${dir} 不可写：${(e as Error).message}`);
      }
    }
    if (opts.deep && status === 'ok') {
      const exp = Math.floor(Date.now() / 1000) + 60;
      const t = await this.sign({ v: 1, uid: '_probe', prefix: 'raw/_probe/', exp, maxFiles: 1, maxBytesPerFile: 1, jti: randomUUID() });
      await this.verify(t);
    }
    const ttl = this.deps.cfg.identity.IDENTITY_TOKEN_TTL_SEC;
    return {
      status,
      detail: problems.length ? problems.join('；')
        : `应用自签的前缀令牌（raw/<userId>/，有效期 ${ttl} 秒，分片 ${this.deps.cfg.identity.IDENTITY_PART_SIZE_MB} MB）· 字节经过 EC2`,
      confidence: 'confirmed',
    };
  }

  async openSession(who: Principal, _opts?: { bypass?: boolean }): Promise<DirectUploadSession> {
    const uid = currentContext()?.userId ?? who.subject;
    const ttl = this.deps.cfg.identity.IDENTITY_TOKEN_TTL_SEC;
    const exp = Math.floor(Date.now() / 1000) + ttl;
    const prefix = `raw/${uid}/`;
    const token = await this.sign({ v: 1, uid, prefix, exp, maxFiles: TOKEN_MAX_FILES, maxBytesPerFile: this.maxBytes(), jti: randomUUID() });
    markPath('identity-pool', 'none:token');
    const s3 = this.deps.cfg.storage.STORAGE_DRIVER === 's3';
    return {
      mode: 'token', token, expiresAt: new Date(exp * 1000).toISOString(), prefix, partSize: this.partSize(),
      partUrl: s3 ? '/api/uploads/parts:sign' : '/api/storage/upload',
    };
  }

  async authorizePart(token: string, key: string, uploadId: string, part: number): Promise<{ url?: string }> {
    const p = await this.verify(token);
    if (!key.startsWith(p.prefix)) throw new HttpError(403, 'UPLOAD_PREFIX_DENIED', `键不在令牌前缀 ${p.prefix} 之内`);
    const m = KEY_RE.exec(key);
    if (!m || m[1] !== p.uid) throw new HttpError(403, 'UPLOAD_PREFIX_DENIED', '键必须是 raw/<userId>/<photoId>.<jpg|png|webp>');
    const photoId = m[2]!;
    const db = this.deps.db;
    if (!db) throw new Error('PrefixTokenUpload: 缺少依赖 db');
    const photo = await getPhoto(db, photoId);
    if (!photo || photo.ownerId !== p.uid || photo.rawKey !== key) throw new HttpError(403, 'UPLOAD_PREFIX_DENIED', '照片不存在或不属于令牌主人');
    if (photo.status !== 'UPLOADING') throw new HttpError(409, 'UPLOAD_NOT_ACCEPTING', `照片状态为 ${photo.status}，不再接受分片`);
    markPath('identity-pool', 'none:token');

    const s3 = asS3Multipart(this.storage());
    if (!s3) return {};
    // storage=s3：后端代为创建分片上传；约定客户端的 uploadId = photoId
    let s3UploadId = this.s3Uploads.get(photoId);
    if (!s3UploadId) {
      s3UploadId = (await s3.createMultipartUpload(key, { contentType: photo.contentType, metadata: { photoid: photoId, ownerid: p.uid } })).uploadId;
      this.s3Uploads.set(photoId, s3UploadId);
    }
    void uploadId;
    const signed = await s3.presignUploadPart(key, s3UploadId, part, Math.min(this.deps.cfg.identity.IDENTITY_TOKEN_TTL_SEC, 3600));
    return { url: signed.url };
  }

  async complete(photoId: string, _who: Principal): Promise<{ ok: boolean; rawKey?: string; reason?: string }> {
    const db = this.deps.db;
    if (!db) throw new Error('PrefixTokenUpload: 缺少依赖 db');
    const photo = await getPhoto(db, photoId);
    if (!photo) return { ok: false, reason: '照片不存在' };
    const storage = this.storage();
    const local = asLocalMultipart(storage);
    if (local) {
      const r = await local.completeParts(photoId, photo.rawKey, { maxBytes: this.maxBytes() });
      return r.ok ? { ok: true, rawKey: photo.rawKey } : { ok: false, reason: r.reason };
    }
    const s3 = asS3Multipart(storage);
    const s3UploadId = this.s3Uploads.get(photoId);
    if (!s3 || !s3UploadId) return { ok: false, reason: '没有进行中的分片上传' };
    const parts = await s3.listParts(photo.rawKey, s3UploadId);
    if (!parts.length) return { ok: false, reason: '没有收到任何分片' };
    await s3.completeMultipartUpload(photo.rawKey, s3UploadId, parts.map((x) => ({ partNumber: x.partNumber, etag: x.etag })));
    this.s3Uploads.delete(photoId);
    return { ok: true, rawKey: photo.rawKey };
  }
}
