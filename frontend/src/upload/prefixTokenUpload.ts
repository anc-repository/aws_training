// F14（identity-pool 未启用 = none 驱动）：应用自签的前缀范围上传令牌（02 组 identity-pool 第 1 节）。
//   1. POST /api/uploads/session → { mode:'token', token, prefix:'raw/<userId>/', partSize, partUrl }（多个文件共用一个令牌）；
//   2. 每个文件先 POST /api/photos（transfer:'multipart'）建档，拿到 photoId、原图键 rawKey 与 uploadId；
//   3. storage=local：PUT /api/storage/upload?key&uploadId&part，请求头 Authorization: CA-Upload <令牌>（令牌不进 URL、不进访问日志）；
//      断点续传先 GET /api/storage/upload/parts?uploadId 查询已收到的分片，只补传缺失的；
//      storage=s3：每一片先 POST /api/uploads/parts:sign 换取预签名 UploadPart URL，再直传 S3（ETag 用于合并）；
//   4. POST /api/photos/:id/complete { uploadId, parts } —— 服务端合并分片并校验大小、类型与文件头。
import { api } from '../api/client';
import { photosApi, uploadsApi } from '../api/endpoints';
import type { DirectUploadSession, Photo } from '../api/types';
import { ensureOk, xhrPut, type PutImpl } from './http';
import type { MultipartContext, ResumeState } from './types';

type TokenSession = Extract<DirectUploadSession, { mode: 'token' }>;

export const DEFAULT_PART_SIZE = 5 * 1024 * 1024;

export function partCount(size: number, partSize: number): number {
  return Math.max(1, Math.ceil(size / Math.max(1, partSize)));
}

/** 原图键的扩展名（与 packages/image-core 的 extensionFor 一致） */
export function extensionForType(contentType: string): string {
  const ct = contentType.toLowerCase();
  return ct === 'image/jpeg' ? 'jpg' : ct === 'image/png' ? 'png' : ct === 'image/webp' ? 'webp' : (ct.split('/')[1] ?? 'bin');
}

/** 后端没有返回 rawKey 时：raw/<userId>/<photoId>.<ext> = 会话前缀 + photoId + 扩展名 */
export function deriveRawKey(prefix: string, photoId: string, contentType: string): string {
  return `${prefix.replace(/\/?$/, '/')}${photoId}.${extensionForType(contentType)}`;
}

/** GET /api/storage/upload/parts 的 parts：数字数组或 [{part, size}] */
export function partNumbers(parts: ReadonlyArray<number | { part?: number; partNumber?: number }> | undefined): number[] {
  return (parts ?? []).map((p) => (typeof p === 'number' ? p : p.part ?? p.partNumber ?? 0)).filter((n) => n > 0);
}

export function caUploadHeader(token: string): Record<string, string> {
  return { Authorization: `CA-Upload ${token}` };
}

function expired(s: TokenSession): boolean {
  const t = Date.parse(s.expiresAt);
  return Number.isFinite(t) && t - Date.now() < 15_000;
}

async function ensureSession(ctx: MultipartContext): Promise<TokenSession> {
  if (ctx.session && !expired(ctx.session)) return ctx.session;
  const s = await (ctx.openSession ?? uploadsApi.openSession)();
  if (s.mode !== 'token') throw new Error('会话不是前缀令牌模式（identity-pool 已启用时应改用 STS 直传）');
  ctx.session = s;
  return s;
}

export async function prefixTokenUpload(file: File, ctx: MultipartContext = {}): Promise<Photo> {
  const put: PutImpl = ctx.put ?? xhrPut;
  let session = await ensureSession(ctx);
  const partSize = session.partSize > 0 ? session.partSize : DEFAULT_PART_SIZE;

  let state: ResumeState;
  if (ctx.resume) {
    state = ctx.resume;
  } else {
    ctx.onStage?.('create');
    const created = await photosApi.create({
      filename: file.name,
      contentType: file.type || 'application/octet-stream',
      sizeBytes: file.size,
      albumId: ctx.albumId ?? null,
      transfer: 'multipart',
    });
    ctx.onCreated?.(created.photo);
    const photoId = created.photo.id;
    // 约定：后端没给 uploadId 时用 photoId；没给 rawKey 时由会话前缀推出
    state = {
      photoId,
      rawKey: created.rawKey ?? deriveRawKey(session.prefix, photoId, created.photo.contentType || file.type),
      uploadId: created.uploadId ?? photoId,
      done: {},
    };
  }
  ctx.onResumeState?.(state);

  const total = partCount(file.size, partSize);
  const local = session.partUrl === '/api/storage/upload';

  // 续传：local 驱动问服务端已经收到了哪些分片
  if (local) {
    try {
      const r = await api<{ parts?: Array<number | { part?: number; partNumber?: number }> }>('/api/storage/upload/parts', {
        query: { uploadId: state.uploadId, key: state.rawKey },
        headers: caUploadHeader(session.token),
      });
      for (const p of partNumbers(r.parts)) state.done[p] ??= '';
    } catch {
      /* 查询失败就全部重传 */
    }
  }

  ctx.onStage?.('upload');
  const doneBytes = () =>
    Object.keys(state.done).reduce((sum, p) => sum + partBytes(Number(p), partSize, file.size), 0);
  ctx.onProgress?.(doneBytes(), file.size);

  for (let part = 1; part <= total; part += 1) {
    if (state.done[part] !== undefined) continue;
    if (ctx.signal?.aborted) throw new DOMException('上传已取消', 'AbortError');
    session = await ensureSession(ctx);
    const start = (part - 1) * partSize;
    const blob = file.slice(start, Math.min(file.size, start + partSize));
    const base = doneBytes();
    const progress = (loaded: number) => ctx.onProgress?.(base + loaded, file.size);
    if (local) {
      const url = `/api/storage/upload?${new URLSearchParams({ key: state.rawKey, uploadId: state.uploadId, part: String(part) })}`;
      const r = await put(url, blob, {
        headers: { ...caUploadHeader(session.token), 'Content-Type': 'application/octet-stream' },
        onProgress: progress,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
      ensureOk(r, `分片 ${part}`);
      state.done[part] = r.etag ?? '';
    } else {
      const signed = await api<{ url: string; method?: 'PUT'; headers?: Record<string, string> }>('/api/uploads/parts:sign', {
        json: { key: state.rawKey, uploadId: state.uploadId, part },
        headers: caUploadHeader(session.token),
      });
      const r = await put(signed.url, blob, {
        headers: signed.headers ?? {},
        onProgress: progress,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
      ensureOk(r, `分片 ${part}`);
      state.done[part] = r.etag ?? '';
    }
    ctx.onResumeState?.(state);
    ctx.onProgress?.(doneBytes(), file.size);
  }

  ctx.onStage?.('complete');
  const parts = Object.entries(state.done)
    .map(([p, etag]) => ({ part: Number(p), ...(etag ? { etag } : {}) }))
    .sort((a, b) => a.part - b.part);
  return photosApi.complete(state.photoId, { uploadId: state.uploadId, parts });
}

function partBytes(part: number, partSize: number, size: number): number {
  const start = (part - 1) * partSize;
  return Math.max(0, Math.min(partSize, size - start));
}
