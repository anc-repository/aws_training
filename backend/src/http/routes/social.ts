// backend/src/http/routes/social.ts —— F9、F11 与点击流采集
//
//   GET    /social/health                                   social-api 探针经网关绕一圈时请求它
//   GET    /social/photos/:id                               计数 + 我是否点过赞
//   POST   /social/photos/:id/likes      DELETE 同路径      点赞 / 取消（幂等，一人一赞）
//   GET    /social/photos/:id/comments                      评论列表（倒序，游标分页）
//   POST   /social/photos/:id/comments                      发表评论（通知照片主人，F10；X-Compare-Bypass: queue 白名单路由）
//   DELETE /social/photos/:id/comments/:commentId           删除自己的评论
//   GET    /social/me/comments                              我的评论
//   POST   /api/shares                                      创建分享链接（F11）
//   GET    /api/shares/:token                               打开分享链接（不需要登录；过期 410）
//   POST   /api/events                                      点击流批量上报（每批最多 50 条；服务端补 userId、ipHash，不存原始 IP）
//   GET    /api/events/report?from&to&groupBy               报表（仅管理员；db 同步，firehose 异步返回 queryId）
//   GET    /api/events/report/:queryId                      异步报表结果（仅管理员）
// 社交写接口按用户限速 SOCIAL_RATE_LIMIT_PER_MIN（计数在 CachePort.incr，ASG-013）；被拦截（BLOCKED）的照片拒绝新的点赞和评论。
import { createHash, createHmac, randomUUID } from 'node:crypto';
import type { Express, Request, Response } from 'express';
import { z } from 'zod';
import type { Container } from '../../container.js';
import { HttpError, isNotImplemented } from '../../errors.js';
import { ensureJobs } from '../../jobs/index.js';
import { emitNotification } from '../../jobs/notify.js';
import { currentContext } from '../../observability/request-context.js';
import type { ClickEvent } from '../../ports/analytics.js';
import { getPhoto, userNames, type Photo } from '../../repositories/photos.js';
import { canView, type Viewer } from '../../services/feed.js';
import { createShareLink, openShare } from '../../services/share.js';
import { requireAdmin } from '../middleware/admin.js';
import { requireAuth } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rate-limit.js';

export const PATHS = [
  '/social/*rest',
  '/api/shares',
  '/api/shares/*rest',
  '/api/events',
  '/api/events/*rest',
] as const;

export function viewerOf(): Viewer & { principal?: NonNullable<ReturnType<typeof currentContext>>['principal'] } {
  const ctx = currentContext();
  return {
    ...(ctx?.userId ? { userId: ctx.userId } : {}),
    isAdmin: Boolean(ctx?.isAdmin),
    ...(ctx?.principal ? { principal: ctx.principal } : {}),
  };
}

/** 路由参数（Express 5 的类型是 string | string[]） */
export function param(req: Request, name: string): string {
  const v = (req.params as Record<string, string | string[] | undefined>)[name];
  return Array.isArray(v) ? v.join('/') : String(v ?? '');
}

export function noStore(res: Response): void {
  res.set('Cache-Control', 'private, no-store');
}

// ---------------------------------------------------------------------------------------------
// 点击流：服务端事件与 ipHash（HMAC(media-hmac-key 派生的子密钥, IP)，不存原始 IP）
// ---------------------------------------------------------------------------------------------
const ipKeys = new WeakMap<object, { key: Buffer; at: number }>();

export async function ipHash(c: Container, ip: string): Promise<string> {
  let k = ipKeys.get(c);
  if (!k || Date.now() - k.at > 300_000) {
    try {
      const media = await c.secrets.get('media-hmac-key');
      k = { key: createHmac('sha256', media).update('analytics:ip-hash:v1').digest(), at: Date.now() };
    } catch {
      k = { key: createHash('sha256').update(`cloudalbum:${c.config.core.APP_BASE_URL}`).digest(), at: Date.now() };
    }
    ipKeys.set(c, k);
  }
  return createHmac('sha256', k.key).update(ip || 'unknown').digest('hex').slice(0, 32);
}

export function uaFamily(ua: string | undefined): string | undefined {
  if (!ua) return undefined;
  if (/edg\//i.test(ua)) return 'Edge';
  if (/chrome\//i.test(ua)) return 'Chrome';
  if (/firefox\//i.test(ua)) return 'Firefox';
  if (/safari\//i.test(ua)) return 'Safari';
  if (/curl|wget|httpie|k6|node|undici|axios|python/i.test(ua)) return 'Tool';
  return 'Other';
}

function sessionOf(req: Request): string {
  const cookies = req.cookies as Record<string, string> | undefined;
  const header = req.get('X-CloudAlbum-Session');
  const s = header || cookies?.ca_sid || '';
  return /^[A-Za-z0-9_-]{8,64}$/.test(s) ? s : `srv-${createHash('sha256').update(`${req.ip}|${req.get('user-agent') ?? ''}`).digest('hex').slice(0, 24)}`;
}

/** 服务层的点击事件（点赞、评论、上传完成、打开分享）：userId 可信；非权威，失败只忽略 */
export async function trackServerEvent(c: Container, req: Request, e: { type: ClickEvent['type']; photoId?: string }): Promise<void> {
  try {
    const ctx = currentContext();
    await c.analytics.track([{
      eventId: randomUUID(), ts: new Date().toISOString(), sessionId: sessionOf(req),
      ...(ctx?.userId ? { userId: ctx.userId } : {}), type: e.type, path: req.path.slice(0, 512),
      ...(e.photoId ? { photoId: e.photoId } : {}), ...(uaFamily(req.get('user-agent')) ? { uaFamily: uaFamily(req.get('user-agent'))! } : {}),
      ipHash: await ipHash(c, req.ip ?? ''),
    }]);
  } catch (e2) {
    if (!isNotImplemented(e2)) c.logger.debug('analytics.track_failed', { error: (e2 as Error).message });
  }
}

// ---------------------------------------------------------------------------------------------
// 社交
// ---------------------------------------------------------------------------------------------
async function viewablePhoto(c: Container, id: string, viewer: Viewer): Promise<Photo> {
  const photo = await getPhoto(c.dbRead, id);
  if (!photo || !canView(photo, viewer)) throw new HttpError(404, 'PHOTO_NOT_FOUND', '照片不存在');
  return photo;
}

function assertInteractive(photo: Photo): void {
  if (photo.status === 'BLOCKED') throw new HttpError(403, 'PHOTO_BLOCKED', '照片已被拦截，不能点赞或评论');
  if (photo.status !== 'READY') throw new HttpError(409, 'PHOTO_NOT_READY', `照片当前状态为 ${photo.status}`);
}

const commentBody = z.object({ text: z.string().trim().min(1, '评论不能为空').max(1000, '评论最多 1000 字') });
const pageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().max(256).optional(),
});
const shareBody = z.object({ photoId: z.string().min(1).max(64), ttlSec: z.coerce.number().int().positive().optional() });
const eventsBody = z.object({
  events: z.array(z.object({
    eventId: z.string().min(1).max(64).optional(),
    ts: z.string().max(40).optional(),
    sessionId: z.string().min(1).max(64).optional(),
    type: z.enum(['page_view', 'photo_view', 'like', 'comment', 'share_open', 'upload']),
    path: z.string().max(512).default('/'),
    photoId: z.string().max(64).optional(),
    referrer: z.string().max(512).optional(),
  })).max(50),
});
const reportQuery = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  groupBy: z.enum(['type', 'day', 'photo']).default('day'),
});

export function parseOr400<T>(schema: z.ZodType<T>, input: unknown): T {
  const r = schema.safeParse(input);
  if (!r.success) {
    throw new HttpError(400, 'BAD_REQUEST', r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
  }
  return r.data;
}

function likeEventId(photoId: string, userId: string): string {
  return `like.created:${createHash('sha256').update(`${photoId}|${userId}`).digest('hex').slice(0, 40)}`;
}

export function register(app: Express, c: Container): void {
  ensureJobs(c);
  const social = c.config.social;
  const limiter = rateLimit(c, { name: 'social', windowSec: 60, max: social.SOCIAL_RATE_LIMIT_PER_MIN });

  app.get('/social/health', (_req, res) => {
    noStore(res);
    res.json({ status: 'ok', driver: social.SOCIAL_DRIVER, via: 'ec2' });
  });

  app.get('/social/me/comments', requireAuth, async (req, res) => {
    const v = viewerOf();
    const q = parseOr400(pageQuery, req.query);
    const page = await c.social.listCommentsByUser(v.userId!, { limit: q.limit, ...(q.cursor ? { cursor: q.cursor } : {}) });
    noStore(res);
    res.json(page);
  });

  app.get('/social/photos/:id', async (req, res) => {
    const v = viewerOf();
    const photo = await viewablePhoto(c, param(req, 'id'), v);
    const [counters, liked] = await Promise.all([
      c.social.getCounters([photo.id]),
      v.userId ? c.social.likedBy([photo.id], v.userId) : Promise.resolve(new Set<string>()),
    ]);
    noStore(res);
    res.json({ photoId: photo.id, counters: counters[photo.id] ?? { likes: 0, comments: 0 }, likedByMe: liked.has(photo.id) });
  });

  app.post('/social/photos/:id/likes', requireAuth, limiter, async (req, res) => {
    const v = viewerOf();
    const photo = await viewablePhoto(c, param(req, 'id'), v);
    assertInteractive(photo);
    const r = await c.social.like(photo.id, v.userId!);
    if (r.created && photo.ownerId !== v.userId) {
      const names = await userNames(c.dbRead, [v.userId!]);
      await emitNotification(c, {
        eventId: likeEventId(photo.id, v.userId!), type: 'like.created', audience: 'user', origin: 'ec2', recipientUserId: photo.ownerId,
        title: '有人赞了你的照片', body: `${names.get(v.userId!) ?? '有人'} 赞了你的照片「${photo.title ?? photo.filename}」`,
        link: `/photos/${photo.id}`, data: { photoId: photo.id, userId: v.userId! },
      });
    }
    if (r.created) await trackServerEvent(c, req, { type: 'like', photoId: photo.id });
    noStore(res);
    res.json({ photoId: photo.id, created: r.created, likes: r.likes, likedByMe: true });
  });

  app.delete('/social/photos/:id/likes', requireAuth, limiter, async (req, res) => {
    const v = viewerOf();
    const photo = await viewablePhoto(c, param(req, 'id'), v);
    const r = await c.social.unlike(photo.id, v.userId!);
    noStore(res);
    res.json({ photoId: photo.id, removed: r.removed, likes: r.likes, likedByMe: false });
  });

  app.get('/social/photos/:id/comments', async (req, res) => {
    const v = viewerOf();
    const photo = await viewablePhoto(c, param(req, 'id'), v);
    const q = parseOr400(pageQuery, req.query);
    const page = await c.social.listComments(photo.id, { limit: q.limit, ...(q.cursor ? { cursor: q.cursor } : {}) });
    const names = await userNames(c.dbRead, page.items.map((i) => i.userId));
    noStore(res);
    res.json({
      items: page.items.map((i) => ({ ...i, user: { id: i.userId, displayName: names.get(i.userId) ?? '' }, mine: i.userId === v.userId })),
      ...(page.next ? { next: page.next } : {}),
    });
  });

  app.post('/social/photos/:id/comments', requireAuth, limiter, async (req, res) => {
    const v = viewerOf();
    const body = parseOr400(commentBody, req.body);
    const photo = await viewablePhoto(c, param(req, 'id'), v);
    assertInteractive(photo);
    const comment = await c.social.addComment(photo.id, v.userId!, body.text);
    const names = await userNames(c.dbRead, [v.userId!]);
    if (photo.ownerId !== v.userId) {
      await emitNotification(c, {
        eventId: `comment.created:${comment.id}`, type: 'comment.created', audience: 'user', origin: 'ec2', recipientUserId: photo.ownerId,
        title: '你的照片有新评论', body: `${names.get(v.userId!) ?? '有人'}：${body.text.slice(0, 140)}`,
        link: `/photos/${photo.id}#comment-${comment.id}`, data: { photoId: photo.id, commentId: comment.id, userId: v.userId! },
      });
    }
    await trackServerEvent(c, req, { type: 'comment', photoId: photo.id });
    noStore(res);
    res.status(201).json({ comment: { ...comment, user: { id: v.userId!, displayName: names.get(v.userId!) ?? '' }, mine: true } });
  });

  app.delete('/social/photos/:id/comments/:commentId', requireAuth, async (req, res) => {
    const v = viewerOf();
    const photo = await viewablePhoto(c, param(req, 'id'), v);
    await c.social.deleteComment(photo.id, param(req, 'commentId'), v.userId!);
    res.status(204).end();
  });

  // ---- 分享链接（F11）----
  app.post('/api/shares', requireAuth, async (req, res) => {
    const v = viewerOf();
    const body = parseOr400(shareBody, req.body);
    const share = await createShareLink(c, { ...v, userId: v.userId! }, body.photoId, body.ttlSec);
    noStore(res);
    res.status(201).json(share);
  });

  app.get('/api/shares/:token', async (req, res) => {
    const r = await openShare(c, param(req, 'token'), viewerOf());
    await trackServerEvent(c, req, { type: 'share_open', photoId: r.photo.id });
    noStore(res);
    res.json(r);
  });

  // ---- 点击流 ----
  app.post('/api/events', async (req, res) => {
    const body = parseOr400(eventsBody, req.body);
    const ctx = currentContext();
    const hash = await ipHash(c, req.ip ?? '');
    const session = sessionOf(req);
    const ua = uaFamily(req.get('user-agent'));
    const now = Date.now();
    const events: ClickEvent[] = body.events.map((e) => {
      const t = e.ts ? Date.parse(e.ts) : NaN;
      // 客户端时间只接受最近 1 天内、且不超前 5 分钟的值，否则用服务器时间
      const ts = Number.isFinite(t) && t <= now + 300_000 && t >= now - 86_400_000 ? new Date(t).toISOString() : new Date(now).toISOString();
      return {
        eventId: e.eventId && /^[A-Za-z0-9_-]{8,64}$/.test(e.eventId) ? e.eventId : randomUUID(),
        ts, sessionId: e.sessionId && /^[A-Za-z0-9_-]{8,64}$/.test(e.sessionId) ? e.sessionId : session,
        ...(ctx?.userId ? { userId: ctx.userId } : {}), type: e.type, path: e.path,
        ...(e.photoId ? { photoId: e.photoId } : {}), ...(e.referrer ? { referrer: e.referrer } : {}), ...(ua ? { uaFamily: ua } : {}),
        ipHash: hash,
      };
    });
    const r = events.length ? await c.analytics.track(events) : { accepted: 0, dropped: 0 };
    noStore(res);
    res.status(202).json(r);
  });

  app.get('/api/events/report', requireAdmin, async (req, res) => {
    const q = parseOr400(reportQuery, req.query);
    const to = q.to && !Number.isNaN(Date.parse(q.to)) ? new Date(q.to).toISOString() : new Date().toISOString();
    const from = q.from && !Number.isNaN(Date.parse(q.from)) ? new Date(q.from).toISOString() : new Date(Date.parse(to) - 7 * 86_400_000).toISOString();
    const r = await c.analytics.report({ from, to, groupBy: q.groupBy });
    noStore(res);
    res.json({ driver: c.analytics.meta.driver, from, to, groupBy: q.groupBy, ...r });
  });

  app.get('/api/events/report/:queryId', requireAdmin, async (req, res) => {
    if (typeof c.analytics.reportResult !== 'function') throw new HttpError(404, 'NOT_AVAILABLE', '当前驱动的报表是同步的');
    const r = await c.analytics.reportResult(param(req, 'queryId'));
    noStore(res);
    res.json(r);
  });
}
