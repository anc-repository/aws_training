// backend/src/adapters/storage/local.ts —— StoragePort 的 `local` 驱动（本地实现；shared-fs 的 efs 驱动复用同一个类）
//
// - STORAGE_LOCAL_ROOT 下按逻辑键存放：根目录 + "/" + key 就是文件路径（总纲 2.4），切换到 S3 时键保持不变；
// - 写入一律“.incoming/<随机名> → fsync → rename”：临时文件与目标在同一文件系统，避免 EXDEV；目录 750、文件 640；
// - F6 上传目标：HMAC 签名的 PUT /api/storage/upload?key&ct&max&exp&sig（upload-hmac-key，03#storage 第 1 节）；
// - 媒体读取：公开媒体 /media/<key>（稳定 URL，便于 CDN 缓存），私有媒体追加 exp、sig（media-hmac-key）；
//   /media 路由校验后返回 X-Accel-Redirect 到 <redirectPrefix>/{public|private}/<key>；
// - F14 本地前缀令牌的分片辅助（LocalMultipartUpload）：分片落在 .incoming/<uploadId>/，complete 时按序拼接、fsync、rename；
// - 磁盘保护：剩余空间低于 STORAGE_LOCAL_MIN_FREE_PCT 时拒绝新上传（507），探针在低于 15% 时 degraded。
//
// 适配器方法不为“客户端的错”抛异常（签名错误、超限、重复上传都以返回值表达），因为 instrument 代理会把抛出的异常
// 计入权威端口的被动健康信号；只有磁盘写满（507）与真正的 I/O 故障才抛出。
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, readdir, readFile, rename, rm, rmdir, stat, statfs, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable, Transform, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ModuleId } from '@cloudalbum/contracts';
import { storageLocalRoot } from '../../config/schema.js';
import { HttpError } from '../../errors.js';
import { markPath } from '../../observability/request-context.js';
import type { AdapterMeta, Page, ProbeResult } from '../../ports/common.js';
import type { SecretName } from '../../ports/secrets.js';
import type { ObjectInfo, StoragePort, StoredObject, UploadTarget, Visibility } from '../../ports/storage.js';
import type { AdapterDeps } from '../types.js';

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

export const UPLOAD_PATH = '/api/storage/upload';
export const MEDIA_PATH = '/media';
/** 探针在剩余空间低于该比例时置 degraded（前端把上传按钮置灰） */
export const DEGRADED_FREE_PCT = 15;
const INCOMING = '.incoming';
const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._\-/]{0,511}$/;
const UPLOAD_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const MAX_PARTS = 10_000;
const SECRET_TTL_MS = 60_000;

const CONTENT_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.csv': 'text/csv; charset=utf-8',
  '.json': 'application/json', '.txt': 'text/plain; charset=utf-8',
};

export function contentTypeForKey(key: string): string {
  return CONTENT_TYPES[path.extname(key).toLowerCase()] ?? 'application/octet-stream';
}

/** 逻辑键校验：相对路径、无 `.`/`..` 段、不进入 .incoming */
export function isValidKey(key: string): boolean {
  if (!KEY_RE.test(key)) return false;
  const segs = key.split('/');
  return segs.every((s) => s !== '' && s !== '.' && s !== '..') && segs[0] !== INCOMING;
}

export function isValidUploadId(id: string): boolean {
  return UPLOAD_ID_RE.test(id);
}

/** 对象不存在（getObject）。路由应先 headObject；它只在竞态下出现 */
export class ObjectNotFoundError extends Error {
  readonly code = 'NoSuchKey';
  readonly status = 404;
  constructor(readonly key: string) {
    super(`对象不存在：${key}`);
    this.name = 'ObjectNotFoundError';
  }
}

export type UploadSignatureCheck =
  | { ok: true; key: string; contentType: string; maxBytes: number; expiresAt: number }
  | { ok: false; code: 'UPLOAD_SIGNATURE_INVALID' | 'UPLOAD_URL_EXPIRED' | 'UPLOAD_PARAMS_INVALID'; message: string };

export type WriteResult =
  | { ok: true; info: ObjectInfo; sha256?: string; idempotent?: boolean }
  | { ok: false; status: 400 | 409 | 413 | 507; code: string; message: string };

export interface PartInfo { part: number; size: number; etag: string; lastModified: string }

export type PartWriteResult = ({ ok: true } & PartInfo) | { ok: false; status: 400 | 413 | 507; code: string; message: string };

export type CompletePartsResult = { ok: true; info: ObjectInfo; parts: number } | { ok: false; reason: string };

/** F14 本地前缀令牌的分片辅助（identity-pool none 驱动 + uploads 路由使用）；s3 驱动有自己的分片辅助 */
export interface LocalMultipartUpload {
  writePart(uploadId: string, part: number, body: Readable, opts: { maxBytes: number; contentLength?: number }): Promise<PartWriteResult>;
  listParts(uploadId: string): Promise<PartInfo[]>;
  /** 按 1..n 顺序拼接全部分片到 destKey（fsync + rename），然后删除分片目录；maxBytes 为合并后的上限 */
  completeParts(uploadId: string, destKey: string, opts: { maxBytes: number; expectedParts?: number }): Promise<CompletePartsResult>;
  abortParts(uploadId: string): Promise<void>;
  /** 清理 .incoming/ 中超过 olderThanMs 未更新的残留（分片目录与临时文件），image.reconcile 调用 */
  cleanupIncoming(olderThanMs: number): Promise<{ removed: number }>;
}

/** StoragePort 是否带本地分片辅助（经 instrument 代理后同样可用） */
export function asLocalMultipart(s: StoragePort): (StoragePort & LocalMultipartUpload) | null {
  const x = s as Partial<LocalMultipartUpload>;
  return typeof x.writePart === 'function' && typeof x.completeParts === 'function' ? (s as StoragePort & LocalMultipartUpload) : null;
}

/** StoragePort 是否带本地上传 / 媒体签名校验（local 与 efs 驱动） */
export function asLocalStorage(s: StoragePort): (StoragePort & LocalStorage) | null {
  return typeof (s as Partial<LocalStorage>).verifyUploadSignature === 'function' ? (s as StoragePort & LocalStorage) : null;
}

export function signUpload(secret: string, p: { key: string; contentType: string; maxBytes: number; exp: number }): string {
  return createHmac('sha256', secret).update(`PUT\n${p.key}\n${p.contentType}\n${p.maxBytes}\n${p.exp}`).digest('base64url');
}

export function signMedia(secret: string, key: string, exp: number): string {
  return createHmac('sha256', secret).update(`GET\n${key}\n${exp}`).digest('base64url');
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * 字节计数 + sha256 旁路计算。超过上限后不再向磁盘写任何字节，但继续读完请求体（受 Nginx client_max_body_size 约束），
 * 这样连接不会被重置，客户端能收到 413（直接销毁请求流会让浏览器只看到“连接被重置”）。
 */
class Meter extends Transform {
  bytes = 0;
  overflow = false;
  private readonly hash = createHash('sha256');
  constructor(private readonly max: number) {
    super();
  }
  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    this.bytes += chunk.length;
    if (this.overflow || this.bytes > this.max) {
      this.overflow = true;
      cb();
      return;
    }
    this.hash.update(chunk);
    cb(null, chunk);
  }
  digest(): string {
    return this.hash.digest('hex');
  }
}

function partFile(part: number): string {
  return `${String(part).padStart(6, '0')}.part`;
}

export class LocalStorage implements StoragePort, LocalMultipartUpload {
  readonly meta: AdapterMeta;
  private readonly secretCache = new Map<SecretName, { value: string; at: number }>();
  private readonly segment: string;

  constructor(
    protected readonly deps: AdapterDeps,
    protected readonly options: LocalStorageOptions = {
      root: storageLocalRoot(deps.cfg), module: 'storage', driver: 'local', awsService: null, redirectPrefix: '/_media_local',
    },
  ) {
    this.meta = { module: options.module, driver: options.driver, awsService: options.awsService, authoritative: true };
    this.segment = options.driver;
  }

  get root(): string {
    return this.options.root;
  }

  private abs(key: string): string {
    if (!isValidKey(key)) throw new HttpError(400, 'INVALID_KEY', `非法的存储键：${key}`);
    return path.join(this.options.root, ...key.split('/'));
  }

  private incoming(...p: string[]): string {
    return path.join(this.options.root, INCOMING, ...p);
  }

  private mark(outcome: string): void {
    markPath(this.options.module, `${this.segment}:${outcome}`);
  }

  private minFreePct(): number {
    const s = this.deps.cfg.storage;
    return 'STORAGE_LOCAL_MIN_FREE_PCT' in s ? s.STORAGE_LOCAL_MIN_FREE_PCT : 10;
  }

  private async secret(name: 'upload-hmac-key' | 'media-hmac-key'): Promise<string> {
    const hit = this.secretCache.get(name);
    if (hit && Date.now() - hit.at < SECRET_TTL_MS) return hit.value;
    const secrets = this.deps.secrets;
    if (!secrets) throw new Error('LocalStorage: 缺少 SecretsPort（container 装配顺序错误）');
    const value = await secrets.get(name);
    if (!value) throw new Error(`机密 ${name} 为空`);
    this.secretCache.set(name, { value, at: Date.now() });
    return value;
  }

  async init(): Promise<void> {
    await mkdir(this.incoming(), { recursive: true, mode: 0o750 });
  }

  /** 剩余空间（statfs）；不支持时返回 null */
  async capacity(): Promise<{ freePct: number; freeBytes: number; totalBytes: number } | null> {
    try {
      const s = await statfs(this.options.root);
      const total = Number(s.blocks) * Number(s.bsize);
      const free = Number(s.bavail) * Number(s.bsize);
      if (!total) return null;
      return { freePct: Math.round((free / total) * 1000) / 10, freeBytes: free, totalBytes: total };
    } catch {
      return null;
    }
  }

  private async diskFull(): Promise<{ freePct: number } | null> {
    const cap = await this.capacity();
    return cap && cap.freePct < this.minFreePct() ? { freePct: cap.freePct } : null;
  }

  private async mountType(): Promise<string | null> {
    if (process.platform !== 'linux') return null;
    try {
      const mounts = (await readFile('/proc/mounts', 'utf8')).split('\n').map((l) => l.split(' '));
      let best: { point: string; type: string } | null = null;
      const root = path.resolve(this.options.root);
      for (const [, point, type] of mounts) {
        if (!point || !type) continue;
        if ((root === point || root.startsWith(point.endsWith('/') ? point : `${point}/`)) && (!best || point.length > best.point.length)) {
          best = { point, type };
        }
      }
      return best?.type ?? null;
    } catch {
      return null;
    }
  }

  async probe(_opts?: { deep?: boolean }): Promise<ProbeResult> {
    const t0 = Date.now();
    try {
      await mkdir(this.incoming(), { recursive: true, mode: 0o750 });
      const probeFile = this.incoming(`_probe-${process.pid}-${randomBytes(4).toString('hex')}`);
      const fh = await open(probeFile, 'wx', 0o640);
      try {
        await fh.writeFile('probe');
        await fh.sync();
      } finally {
        await fh.close();
      }
      await unlink(probeFile);
    } catch (e) {
      return { status: 'error', detail: `上传目录不可写：${(e as Error).message}`, latencyMs: Date.now() - t0, data: { root: this.options.root } };
    }
    if (this.options.requireMountType) {
      const type = await this.mountType();
      if (!type || !type.startsWith(this.options.requireMountType)) {
        return { status: 'error', detail: `${this.options.root} 不是 ${this.options.requireMountType} 挂载（实际：${type ?? '未知'}）`, latencyMs: Date.now() - t0 };
      }
    }
    const cap = await this.capacity();
    const residue = await readdir(this.incoming()).then((x) => x.length).catch(() => 0);
    const where = this.options.driver === 'efs' ? 'EFS（NFS）' : 'EC2 本地磁盘（EBS）';
    const data = { root: this.options.root, incomingEntries: residue, ...(cap ?? {}) };
    if (cap && cap.freePct < this.minFreePct()) {
      return { status: 'error', detail: `${where} 剩余空间 ${cap.freePct}% 低于 ${this.minFreePct()}%，拒绝新上传（507）`, latencyMs: Date.now() - t0, data };
    }
    if (cap && cap.freePct < DEGRADED_FREE_PCT) {
      return { status: 'degraded', detail: `${where} 剩余空间 ${cap.freePct}%（低于 ${DEGRADED_FREE_PCT}%）`, latencyMs: Date.now() - t0, data };
    }
    return {
      status: 'ok',
      detail: `照片存于${where}${cap ? ` · 剩余 ${cap.freePct}%` : ''}${residue ? ` · .incoming 残留 ${residue}` : ''}`,
      latencyMs: Date.now() - t0,
      data,
    };
  }

  // -------------------------------------------------------------------------------------------
  // F6：签名上传目标
  // -------------------------------------------------------------------------------------------
  async createUploadTarget(input: { key: string; contentType: string; maxBytes: number; expiresInSec: number; metadata?: Record<string, string> }): Promise<UploadTarget> {
    if (!isValidKey(input.key)) throw new HttpError(400, 'INVALID_KEY', `非法的存储键：${input.key}`);
    const full = await this.diskFull();
    if (full) throw new HttpError(507, 'INSUFFICIENT_STORAGE', `数据卷剩余空间 ${full.freePct}% 低于 ${this.minFreePct()}%，暂停接收上传`);
    const exp = Math.floor(Date.now() / 1000) + Math.max(1, Math.floor(input.expiresInSec));
    const maxBytes = Math.max(1, Math.floor(input.maxBytes));
    const sig = signUpload(await this.secret('upload-hmac-key'), { key: input.key, contentType: input.contentType, maxBytes, exp });
    const qs = new URLSearchParams({ key: input.key, ct: input.contentType, max: String(maxBytes), exp: String(exp), sig });
    this.mark('sign');
    return {
      method: 'PUT',
      url: `${UPLOAD_PATH}?${qs.toString()}`,
      headers: { 'Content-Type': input.contentType },
      expiresAt: new Date(exp * 1000).toISOString(),
    };
  }

  /** PUT /api/storage/upload 的第 1 步：签名与有效期（timingSafeEqual） */
  async verifyUploadSignature(q: { key?: unknown; ct?: unknown; max?: unknown; exp?: unknown; sig?: unknown }): Promise<UploadSignatureCheck> {
    const key = typeof q.key === 'string' ? q.key : '';
    const ct = typeof q.ct === 'string' ? q.ct : '';
    const max = Number(q.max);
    const exp = Number(q.exp);
    const sig = typeof q.sig === 'string' ? q.sig : '';
    if (!key || !ct || !sig || !Number.isInteger(max) || max <= 0 || !Number.isInteger(exp) || !isValidKey(key)) {
      return { ok: false, code: 'UPLOAD_PARAMS_INVALID', message: '上传参数不完整或非法' };
    }
    const expected = signUpload(await this.secret('upload-hmac-key'), { key, contentType: ct, maxBytes: max, exp });
    if (!safeEqual(expected, sig)) return { ok: false, code: 'UPLOAD_SIGNATURE_INVALID', message: '上传签名无效' };
    if (exp * 1000 < Date.now()) return { ok: false, code: 'UPLOAD_URL_EXPIRED', message: '上传地址已过期，请重新申请' };
    return { ok: true, key, contentType: ct, maxBytes: max, expiresAt: exp };
  }

  /** PUT /api/storage/upload 的第 3～6 步：大小、剩余空间、幂等重试、流式写盘（.incoming → fsync → rename） */
  async writeUpload(key: string, body: Readable, opts: { maxBytes: number; contentType: string; contentLength?: number }): Promise<WriteResult> {
    if (opts.contentLength !== undefined && opts.contentLength > opts.maxBytes) {
      return { ok: false, status: 413, code: 'UPLOAD_TOO_LARGE', message: `文件大小 ${opts.contentLength} 超过上限 ${opts.maxBytes}` };
    }
    const full = await this.diskFull();
    if (full) return { ok: false, status: 507, code: 'INSUFFICIENT_STORAGE', message: `数据卷剩余空间 ${full.freePct}% 低于 ${this.minFreePct()}%` };
    const existing = await this.headObject(key);
    if (existing) {
      if (opts.contentLength !== undefined && existing.size === opts.contentLength) {
        body.resume();
        this.mark('write');
        return { ok: true, info: existing, idempotent: true };
      }
      return { ok: false, status: 409, code: 'OBJECT_EXISTS', message: '目标对象已存在且大小不同' };
    }
    const r = await this.writeStream(this.abs(key), body, opts.maxBytes);
    if (!r.ok) return r;
    this.mark('write');
    const info = await this.headObject(key);
    return { ok: true, info: info!, sha256: r.sha256 };
  }

  /** 流式写入：.incoming 临时文件（wx, 0640）→ fsync（flush: true，关闭前刷盘）→ rename；任何错误或客户端中断都删除临时文件 */
  private async writeStream(dest: string, body: Readable, maxBytes: number): Promise<{ ok: true; bytes: number; sha256: string } | { ok: false; status: 400 | 413; code: string; message: string }> {
    await mkdir(this.incoming(), { recursive: true, mode: 0o750 });
    const tmp = this.tmpPath();
    const meter = new Meter(maxBytes);
    try {
      await pipeline(body, meter, createWriteStream(tmp, { flags: 'wx', mode: 0o640, flush: true }));
      if (meter.overflow) {
        await unlink(tmp).catch(() => undefined);
        return { ok: false, status: 413, code: 'UPLOAD_TOO_LARGE', message: `超过上限 ${maxBytes} 字节` };
      }
      await mkdir(path.dirname(dest), { recursive: true, mode: 0o750 });
      await rename(tmp, dest);
      return { ok: true, bytes: meter.bytes, sha256: meter.digest() };
    } catch (e) {
      await unlink(tmp).catch(() => undefined);
      const code = (e as { code?: string }).code;
      if (code === 'ERR_STREAM_PREMATURE_CLOSE' || code === 'ECONNRESET' || code === 'ERR_STREAM_DESTROYED') {
        return { ok: false, status: 400, code: 'UPLOAD_ABORTED', message: '客户端中断了上传' };
      }
      throw e;
    }
  }

  private tmpPath(): string {
    return this.incoming(`${os.hostname()}-${process.pid}-${randomBytes(8).toString('hex')}.tmp`);
  }

  // -------------------------------------------------------------------------------------------
  // 通用对象操作
  // -------------------------------------------------------------------------------------------
  async putObject(key: string, body: Buffer | Readable, _opts: { contentType: string; cacheControl?: string; metadata?: Record<string, string> }): Promise<void> {
    const dest = this.abs(key);
    const stream = Buffer.isBuffer(body) ? Readable.from([body]) : body;
    const r = await this.writeStream(dest, stream, Number.MAX_SAFE_INTEGER);
    if (!r.ok) throw new Error(`写入 ${key} 失败：${r.message}`);
    this.mark('write');
  }

  async getObject(key: string): Promise<{ info: ObjectInfo; body: Readable }> {
    const info = await this.headObject(key);
    if (!info) throw new ObjectNotFoundError(key);
    return { info, body: createReadStream(this.abs(key)) };
  }

  async headObject(key: string): Promise<ObjectInfo | null> {
    try {
      const s = await stat(this.abs(key));
      if (!s.isFile()) return null;
      return {
        key, size: s.size, contentType: contentTypeForKey(key), lastModified: s.mtime.toISOString(),
        etag: `"${s.size.toString(16)}-${Math.floor(s.mtimeMs).toString(16)}"`,
      };
    } catch (e) {
      if ((e as { code?: string }).code === 'ENOENT' || (e as { code?: string }).code === 'ENOTDIR') return null;
      throw e;
    }
  }

  async deleteObjects(keys: string[]): Promise<void> {
    const dirs = new Set<string>();
    for (const key of keys) {
      const file = this.abs(key);
      await unlink(file).catch((e: { code?: string }) => {
        if (e.code !== 'ENOENT') throw e;
      });
      dirs.add(path.dirname(file));
    }
    // 删除因此变空的目录（例如 variants/<photoId>/），直到根目录为止
    for (const d of dirs) {
      let cur = d;
      while (cur.startsWith(this.options.root) && path.resolve(cur) !== path.resolve(this.options.root)) {
        try {
          await rmdir(cur);
        } catch {
          break;
        }
        cur = path.dirname(cur);
      }
    }
  }

  async list(prefix: string, cursor?: string, pageSize = 1000): Promise<Page<ObjectInfo>> {
    const keys: string[] = [];
    const slash = prefix.lastIndexOf('/');
    const startDir = slash >= 0 ? prefix.slice(0, slash) : '';
    if (startDir && !isValidKey(startDir)) return { items: [] };
    const walk = async (relDir: string): Promise<void> => {
      const absDir = relDir ? path.join(this.options.root, ...relDir.split('/')) : this.options.root;
      let entries;
      try {
        entries = await readdir(absDir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const ent of entries) {
        if (!relDir && ent.name === INCOMING) continue;
        const rel = relDir ? `${relDir}/${ent.name}` : ent.name;
        if (ent.isDirectory()) {
          if (prefix.startsWith(`${rel}/`) || rel.startsWith(prefix) || `${rel}/`.startsWith(prefix)) await walk(rel);
        } else if (ent.isFile() && rel.startsWith(prefix) && (!cursor || rel > cursor)) {
          keys.push(rel);
        }
      }
    };
    await walk(startDir);
    keys.sort();
    const page = keys.slice(0, pageSize);
    const items: ObjectInfo[] = [];
    for (const k of page) {
      const info = await this.headObject(k);
      if (info) items.push(info);
    }
    return { items, ...(keys.length > pageSize ? { next: page[page.length - 1]! } : {}) };
  }

  // -------------------------------------------------------------------------------------------
  // 媒体读取
  // -------------------------------------------------------------------------------------------
  async createReadUrl(key: string, opts: { visibility: Visibility; expiresInSec: number }): Promise<string> {
    const encoded = key.split('/').map(encodeURIComponent).join('/');
    if (opts.visibility === 'public') return `${MEDIA_PATH}/${encoded}`;
    // 私有媒体：exp 向上取整到 60 秒，同一分钟内签出的 URL 相同（浏览器缓存友好；不回拨签名时间）
    const exp = Math.ceil((Date.now() / 1000 + Math.max(60, opts.expiresInSec)) / 60) * 60;
    const sig = signMedia(await this.secret('media-hmac-key'), key, exp);
    return `${MEDIA_PATH}/${encoded}?exp=${exp}&sig=${sig}`;
  }

  /** /media 路由：私有媒体的签名校验（忽略 exp、sig 以外的查询参数） */
  async verifyMediaSignature(key: string, exp: unknown, sig: unknown): Promise<boolean> {
    const e = Number(exp);
    if (!Number.isInteger(e) || typeof sig !== 'string' || !sig || e * 1000 < Date.now()) return false;
    return safeEqual(signMedia(await this.secret('media-hmac-key'), key, e), sig);
  }

  internalRedirectPath(key: string, visibility: Visibility): string | null {
    if (!isValidKey(key)) return null;
    return `${this.options.redirectPrefix}/${visibility}/${key.split('/').map(encodeURIComponent).join('/')}`;
  }

  /** /media 路由在 X-Accel-Redirect / 直接流式返回之后记下的结果段（local:accel / local:stream） */
  markMediaServed(mode: 'accel' | 'stream'): void {
    this.mark(mode);
  }

  // -------------------------------------------------------------------------------------------
  // F14：本地分片辅助
  // -------------------------------------------------------------------------------------------
  private partDir(uploadId: string): string {
    if (!isValidUploadId(uploadId)) throw new HttpError(400, 'INVALID_UPLOAD_ID', 'uploadId 非法');
    return this.incoming(uploadId);
  }

  async writePart(uploadId: string, part: number, body: Readable, opts: { maxBytes: number; contentLength?: number }): Promise<PartWriteResult> {
    if (!isValidUploadId(uploadId) || !Number.isInteger(part) || part < 1 || part > MAX_PARTS) {
      return { ok: false, status: 400, code: 'INVALID_PART', message: 'uploadId 或 part 非法（part 从 1 开始）' };
    }
    if (opts.contentLength !== undefined && opts.contentLength > opts.maxBytes) {
      return { ok: false, status: 413, code: 'PART_TOO_LARGE', message: `分片大小 ${opts.contentLength} 超过上限 ${opts.maxBytes}` };
    }
    const full = await this.diskFull();
    if (full) return { ok: false, status: 507, code: 'INSUFFICIENT_STORAGE', message: `数据卷剩余空间 ${full.freePct}% 低于 ${this.minFreePct()}%` };
    const dir = this.partDir(uploadId);
    await mkdir(dir, { recursive: true, mode: 0o750 });
    // 同一分片重传时覆盖旧文件（rename 原子替换）
    const r = await this.writeStream(path.join(dir, partFile(part)), body, opts.maxBytes);
    if (!r.ok) return r;
    this.mark('part');
    const s = await stat(path.join(dir, partFile(part)));
    return { ok: true, part, size: r.bytes, etag: `"${r.sha256.slice(0, 32)}"`, lastModified: s.mtime.toISOString() };
  }

  async listParts(uploadId: string): Promise<PartInfo[]> {
    const dir = this.partDir(uploadId);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return [];
    }
    const parts: PartInfo[] = [];
    for (const n of names) {
      const m = /^(\d{6})\.part$/.exec(n);
      if (!m) continue;
      const s = await stat(path.join(dir, n));
      parts.push({ part: Number(m[1]), size: s.size, etag: `"${s.size.toString(16)}-${Math.floor(s.mtimeMs).toString(16)}"`, lastModified: s.mtime.toISOString() });
    }
    return parts.sort((a, b) => a.part - b.part);
  }

  async completeParts(uploadId: string, destKey: string, opts: { maxBytes: number; expectedParts?: number }): Promise<CompletePartsResult> {
    const parts = await this.listParts(uploadId);
    if (!parts.length) return { ok: false, reason: '没有收到任何分片' };
    for (let i = 0; i < parts.length; i++) {
      if (parts[i]!.part !== i + 1) return { ok: false, reason: `缺少分片 ${i + 1}` };
    }
    if (opts.expectedParts !== undefined && parts.length !== opts.expectedParts) {
      return { ok: false, reason: `分片数 ${parts.length} 与预期 ${opts.expectedParts} 不符` };
    }
    const total = parts.reduce((s, p) => s + p.size, 0);
    if (total > opts.maxBytes) return { ok: false, reason: `合并后大小 ${total} 超过上限 ${opts.maxBytes}` };
    const dir = this.partDir(uploadId);
    const dest = this.abs(destKey);
    const tmp = this.tmpPath();
    try {
      const out = createWriteStream(tmp, { flags: 'wx', mode: 0o640, flush: true });
      for (const p of parts) await pipeline(createReadStream(path.join(dir, partFile(p.part))), out, { end: false });
      await new Promise<void>((resolve, reject) => {
        out.once('error', reject);
        out.once('close', () => resolve());
        out.end();
      });
      await mkdir(path.dirname(dest), { recursive: true, mode: 0o750 });
      await rename(tmp, dest);
    } catch (e) {
      await unlink(tmp).catch(() => undefined);
      throw e;
    }
    await rm(dir, { recursive: true, force: true });
    this.mark('part');
    return { ok: true, info: (await this.headObject(destKey))!, parts: parts.length };
  }

  async abortParts(uploadId: string): Promise<void> {
    await rm(this.partDir(uploadId), { recursive: true, force: true });
  }

  async cleanupIncoming(olderThanMs: number): Promise<{ removed: number }> {
    const cutoff = Date.now() - olderThanMs;
    let removed = 0;
    let names: string[];
    try {
      names = await readdir(this.incoming());
    } catch {
      return { removed };
    }
    for (const n of names) {
      const p = this.incoming(n);
      try {
        const s = await stat(p);
        if (s.mtimeMs < cutoff) {
          await rm(p, { recursive: true, force: true });
          removed++;
        }
      } catch {
        /* 并发删除 */
      }
    }
    return { removed };
  }

  // -------------------------------------------------------------------------------------------
  // Migratable<StoredObject>（scripts/migrate 的 copyViaPorts）
  // -------------------------------------------------------------------------------------------
  async count(): Promise<number> {
    let n = 0;
    let cursor: string | undefined;
    do {
      const page = await this.list('', cursor);
      n += page.items.length;
      cursor = page.next;
    } while (cursor);
    return n;
  }

  async exportBatch(cursor?: string, limit = 100): Promise<{ items: StoredObject[]; next?: string }> {
    const page = await this.list('', cursor, limit);
    const items = page.items.map((info) => ({ info, body: async () => createReadStream(this.abs(info.key)) as Readable }));
    return { items, ...(page.next ? { next: page.next } : {}) };
  }

  async importBatch(items: StoredObject[]): Promise<{ written: number; skipped: number }> {
    let written = 0;
    let skipped = 0;
    for (const it of items) {
      const cur = await this.headObject(it.info.key);
      if (cur && cur.size === it.info.size) {
        skipped++;
        continue;
      }
      if (cur) await this.deleteObjects([it.info.key]);
      await this.putObject(it.info.key, await it.body(), { contentType: it.info.contentType });
      written++;
    }
    return { written, skipped };
  }
}
