// F6：逐文件签名 URL 上传（总纲 2.8 F6、12.2）。
//   POST /api/photos → 后端返回 UploadTarget（local：HMAC 签名的 PUT /api/storage/upload?key&ct&max&exp&sig；
//   s3：预签名 PUT URL）→ 浏览器原样执行 PUT（URL + 头）→ POST /api/photos/:id/complete。
// 前端流程与 S3 预签名完全一致，没有驱动分支；“上传到 EC2 / 直传 S3”只体现在徽章上。
import { photosApi } from '../api/endpoints';
import type { Photo } from '../api/types';
import { ensureOk, xhrPut, type PutImpl } from './http';
import type { UploadContext } from './types';

export async function signedUrlUpload(file: File, ctx: UploadContext = {}): Promise<Photo> {
  const put: PutImpl = ctx.put ?? xhrPut;
  ctx.onStage?.('create');
  const created = await photosApi.create({
    filename: file.name,
    contentType: file.type || 'application/octet-stream',
    sizeBytes: file.size,
    albumId: ctx.albumId ?? null,
    transfer: 'single',
  });
  ctx.onCreated?.(created.photo);
  const target = created.upload;
  if (!target) throw new Error('后端没有返回 UploadTarget（POST /api/photos 的 upload 字段）');

  ctx.onStage?.('upload');
  const r = await put(target.url, file, {
    headers: target.headers ?? {},
    onProgress: (loaded, total) => ctx.onProgress?.(loaded, total),
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  });
  ensureOk(r, '上传');
  ctx.onProgress?.(file.size, file.size);

  ctx.onStage?.('complete');
  return photosApi.complete(created.photo.id);
}
