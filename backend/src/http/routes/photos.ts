// backend/src/http/routes/photos.ts —— F5–F8：照片、时间线、搜索
//
//   GET    /api/feed?scope=mine|public&limit&cursor         时间线（cache-aside；X-Compare-Bypass: cache / replica）
//   GET    /api/search?tag=color:blue                        按标签搜索（photo_labels 索引）
//   GET    /api/search/tags                                  热门标签
//   GET    /api/photos?albumId=&limit&cursor                 相册内照片（不带 albumId = 我的照片）
//   POST   /api/photos                                       建档 + 上传目标（F6：UploadTarget，前端流程与 S3 预签名一致）
//   POST   /api/photos/:id/complete                          上传完成 → PhotoPipeline（inline 档 200 READY；worker / lambda 档 202）
//   GET    /api/photos/:id                                   照片详情（标签、审核结论、处理记录；主人另有原图 URL 与拍摄地点）
//   GET    /api/photos/:id/pipeline                          处理流程（job_runs 的 pipeline.* 步骤，“处理流程”抽屉）
//   PATCH  /api/photos/:id                                   修改标题、说明、可见性、相册
//   DELETE /api/photos/:id                                   删除（对象、社交数据、照片行）
//   POST   /api/photos/:id/moderation {action: block|unblock}   管理员复核（/admin/reviews）
import type { Express } from 'express';
import { z } from 'zod';
import type { Container } from '../../container.js';
import { HttpError } from '../../errors.js';
import { ensureJobs } from '../../jobs/index.js';
import { emitNotification } from '../../jobs/notify.js';
import { listSteps } from '../../repositories/job-runs.js';
import { getAlbumRef, getLabels, getModeration, getPhoto, setBlocked, topLabels, updatePhoto } from '../../repositories/photos.js';
import { bumpFeedVersions, canView, getAlbumPhotos, getFeed, presentPhotos, searchPhotos } from '../../services/feed.js';
import { completeUpload, createUpload, decryptPhotoLocation, deletePhoto } from '../../services/photo-pipeline.js';
import { requireAdmin } from '../middleware/admin.js';
import { audit } from '../middleware/audit.js';
import { requireAuth } from '../middleware/auth.js';
import { noStore, param, parseOr400, trackServerEvent, viewerOf } from './social.js';

export const PATHS = [
  '/api/photos',
  '/api/photos/*rest',
  '/api/feed',
  '/api/search',
  '/api/search/*rest',
] as const;

const pageQuery = {
  limit: z.coerce.number().int().min(1).max(100).default(24),
  cursor: z.string().max(512).optional(),
};
const feedQuery = z.object({ scope: z.enum(['mine', 'public']).optional(), ...pageQuery });
const searchQuery = z.object({ tag: z.string().trim().min(1).max(128), ...pageQuery });
const listQuery = z.object({ albumId: z.string().max(64).optional(), ...pageQuery });
const createBody = z.object({
  contentType: z.string().min(1).max(64),
  filename: z.string().max(255).optional(),
  size: z.coerce.number().int().positive().optional(),
  albumId: z.string().max(64).nullish(),
  visibility: z.enum(['public', 'private']).optional(),
  title: z.string().max(200).nullish(),
  caption: z.string().max(2000).nullish(),
});
const patchBody = z.object({
  title: z.string().max(200).nullable().optional(),
  caption: z.string().max(2000).nullable().optional(),
  visibility: z.enum(['public', 'private']).optional(),
  albumId: z.string().max(64).nullable().optional(),
});
const moderationBody = z.object({ action: z.enum(['block', 'unblock']), reason: z.string().max(500).optional() });

export function register(app: Express, c: Container): void {
  ensureJobs(c);

  app.get('/api/feed', async (req, res) => {
    const v = viewerOf();
    const q = parseOr400(feedQuery, req.query);
    const scope = q.scope ?? (v.userId ? 'mine' : 'public');
    const page = await getFeed(c, v, { scope, limit: q.limit, ...(q.cursor ? { cursor: q.cursor } : {}) });
    noStore(res);
    res.json(page);
  });

  app.get('/api/search/tags', async (_req, res) => {
    noStore(res);
    res.json({ items: await topLabels(c.dbRead, 30) });
  });

  app.get('/api/search', async (req, res) => {
    const q = parseOr400(searchQuery, req.query);
    const page = await searchPhotos(c, viewerOf(), { tag: q.tag, limit: q.limit, ...(q.cursor ? { cursor: q.cursor } : {}) });
    noStore(res);
    res.json({ ...page, tag: q.tag });
  });

  app.get('/api/photos', async (req, res) => {
    const v = viewerOf();
    const q = parseOr400(listQuery, req.query);
    const cursor = q.cursor ? { cursor: q.cursor } : {};
    noStore(res);
    if (q.albumId) {
      res.json(await getAlbumPhotos(c, v, { albumId: q.albumId, limit: q.limit, ...cursor }));
      return;
    }
    if (!v.userId) throw new HttpError(401, 'UNAUTHENTICATED', '需要登录');
    res.json(await getFeed(c, v, { scope: 'mine', limit: q.limit, ...cursor }));
  });

  app.post('/api/photos', requireAuth, async (req, res) => {
    const v = viewerOf();
    const body = parseOr400(createBody, req.body);
    const r = await createUpload(c, { userId: v.userId!, isAdmin: v.isAdmin, ...(v.principal ? { principal: v.principal } : {}) }, {
      contentType: body.contentType, ...(body.filename ? { filename: body.filename } : {}), ...(body.size ? { size: body.size } : {}),
      ...(body.albumId ? { albumId: body.albumId } : {}), ...(body.visibility ? { visibility: body.visibility } : {}),
      ...(body.title ? { title: body.title } : {}), ...(body.caption ? { caption: body.caption } : {}),
    });
    const [photo] = await presentPhotos(c, [r.photo], v, { db: c.db, withSocial: false });
    noStore(res);
    // F14 约定：分片上传的 uploadId 就用 photoId（DirectUploadPort.complete(photoId) 据此找到 .incoming/<uploadId>/）
    res.status(201).json({ photoId: r.photo.id, rawKey: r.photo.rawKey, uploadId: r.photo.id, photo, uploadTarget: r.uploadTarget, upload: r.uploadTarget, maxBytes: r.maxBytes });
  });

  app.post('/api/photos/:id/complete', requireAuth, async (req, res) => {
    const v = viewerOf();
    const r = await completeUpload(c, { userId: v.userId!, isAdmin: v.isAdmin, ...(v.principal ? { principal: v.principal } : {}) }, param(req, 'id'));
    const [photo] = await presentPhotos(c, [r.photo], v, { db: c.db, includeOriginal: true });
    if (!r.already) await trackServerEvent(c, req, { type: 'upload', photoId: r.photo.id });
    noStore(res);
    const pending = r.photo.status === 'PROCESSING' || r.photo.status === 'UPLOADING';
    res.status(pending ? 202 : 200).json({ photo, status: r.photo.status, mode: r.mode, ...(r.executionId ? { executionId: r.executionId } : {}), ...(r.already ? { already: true } : {}) });
  });

  app.get('/api/photos/:id', async (req, res) => {
    const v = viewerOf();
    const photo = await getPhoto(c.dbRead, param(req, 'id'));
    if (!photo || !canView(photo, v)) throw new HttpError(404, 'PHOTO_NOT_FOUND', '照片不存在');
    const privileged = Boolean(v.isAdmin || (v.userId && v.userId === photo.ownerId));
    const [dto] = await presentPhotos(c, [photo], v, { includeOriginal: true });
    const labels = await getLabels(c.dbRead, photo.id);
    const extra: Record<string, unknown> = {};
    if (privileged) {
      extra.moderation = await getModeration(c.dbRead, photo.id);
      extra.location = await decryptPhotoLocation(c, photo);
    }
    noStore(res);
    res.json({
      ...dto, labels: labels.length ? labels : dto!.labels, storage: { driver: c.storage.meta.driver },
      workflow: { driver: c.workflow.meta.driver, attempts: photo.processingAttempts, ...(photo.workflow ?? {}) }, ...extra,
    });
  });

  app.get('/api/photos/:id/pipeline', async (req, res) => {
    const v = viewerOf();
    const photo = await getPhoto(c.dbRead, param(req, 'id'));
    if (!photo || !canView(photo, v)) throw new HttpError(404, 'PHOTO_NOT_FOUND', '照片不存在');
    const steps = await listSteps(c.dbRead, photo.id);
    noStore(res);
    res.json({
      photoId: photo.id, status: photo.status, workflow: { driver: c.workflow.meta.driver }, processedBy: photo.processedBy,
      steps: steps.map((s) => ({
        step: s.name.replace(/^pipeline\./, ''), status: s.status, executor: s.executor, attempt: s.attempt,
        startedAt: s.startedAt, finishedAt: s.finishedAt, error: s.error, detail: s.detail,
      })),
    });
  });

  app.patch('/api/photos/:id', requireAuth, async (req, res) => {
    const v = viewerOf();
    const body = parseOr400(patchBody, req.body);
    const photo = await getPhoto(c.db, param(req, 'id'));
    if (!photo || (photo.ownerId !== v.userId && !v.isAdmin)) throw new HttpError(404, 'PHOTO_NOT_FOUND', '照片不存在');
    if (body.albumId) {
      const album = await getAlbumRef(c.db, body.albumId);
      if (!album || album.ownerId !== photo.ownerId) throw new HttpError(404, 'ALBUM_NOT_FOUND', '相册不存在');
    }
    const updated = (await updatePhoto(c.db, photo.id, body))!;
    await bumpFeedVersions(c.cache, photo).catch(() => undefined);
    if (updated.albumId !== photo.albumId) await bumpFeedVersions(c.cache, updated).catch(() => undefined);
    if (body.visibility && body.visibility !== photo.visibility) {
      await c.social.upsertPhotoSummary({ photoId: updated.id, ownerId: updated.ownerId, visibility: updated.visibility, status: updated.status }).catch(() => undefined);
    }
    const [dto] = await presentPhotos(c, [updated], v, { db: c.db, includeOriginal: true });
    noStore(res);
    res.json(dto);
  });

  app.delete('/api/photos/:id', requireAuth, async (req, res) => {
    const v = viewerOf();
    await deletePhoto(c, { userId: v.userId!, isAdmin: v.isAdmin }, param(req, 'id'));
    await audit(c, { action: 'photo.delete', targetType: 'photo', targetId: param(req, 'id') });
    res.status(204).end();
  });

  app.post('/api/photos/:id/moderation', requireAdmin, async (req, res) => {
    const body = parseOr400(moderationBody, req.body);
    const photo = await getPhoto(c.db, param(req, 'id'));
    if (!photo) throw new HttpError(404, 'PHOTO_NOT_FOUND', '照片不存在');
    const changed = await setBlocked(c.db, photo.id, body.action === 'block');
    if (changed) {
      const status = body.action === 'block' ? 'BLOCKED' : 'READY';
      await bumpFeedVersions(c.cache, photo).catch(() => undefined);
      await c.social.upsertPhotoSummary({ photoId: photo.id, ownerId: photo.ownerId, visibility: photo.visibility, status }).catch(() => undefined);
      if (body.action === 'block') {
        await emitNotification(c, {
          eventId: `blocked:${photo.id}:${Date.now().toString(36)}`, type: 'photo.blocked', audience: 'user', origin: 'ec2',
          recipientUserId: photo.ownerId, title: '照片已被管理员屏蔽', body: body.reason ?? `你的照片「${photo.title ?? photo.filename}」已被管理员屏蔽。`,
          link: `/photos/${photo.id}`, data: { photoId: photo.id },
        });
      }
      await audit(c, { action: `photo.${body.action}`, targetType: 'photo', targetId: photo.id, ...(body.reason ? { details: { reason: body.reason } } : {}) });
    }
    noStore(res);
    res.json({ photoId: photo.id, changed, status: (await getPhoto(c.db, photo.id))!.status });
  });
}
