// backend/src/http/routes/media.ts —— GET /media/<key>：校验签名与权限后由 Nginx 发送文件（03#storage 第 1 节；总纲 2.5）
//
// - variants/…（public）：URL 不带签名；只检查照片存在且不是 BLOCKED（主人与管理员仍可看）；
// - raw/…、reports/…（private）：URL 带 exp、sig（media-hmac-key）；校验时忽略其他查询参数（例如实验用的 lab）；
// - local / efs：返回 X-Accel-Redirect: /_media_local/{public|private}/<key>，Nginx 用 sendfile 零拷贝发送（路径头 storage=local:accel）；
//   开发机没有 Nginx（请求不带 Nginx 设置的 X-CloudAlbum-Entry，且 NODE_ENV≠production）时直接流式返回（storage=local:stream）；
// - s3：internalRedirectPath() 为 null，302 到 createReadUrl()（Cache-Control: private, max-age=60）。
// 另有日报的管理员接口：GET /api/reports/daily（列表）、GET /api/reports/daily/:day（签发读取 URL）、POST /api/reports/daily（立即生成）。
import type { Express, Request, Response } from 'express';
import { z } from 'zod';
import type { Container } from '../../container.js';
import { asLocalStorage, contentTypeForKey, isValidKey } from '../../adapters/storage/local.js';
import { HttpError } from '../../errors.js';
import { currentContext, markPath } from '../../observability/request-context.js';
import { getPhoto } from '../../repositories/photos.js';
import { mediaUrls, visibilityOfKey } from '../../services/media-url.js';
import { generateDailyReport, reportKey } from '../../services/report.js';
import { requireAdmin } from '../middleware/admin.js';
import { noStore, param, parseOr400, viewerOf } from './social.js';

export const PATHS = [
  '/media/*rest',
  '/api/reports/daily',
  '/api/reports/daily/*rest',
] as const;

const CACHE_CONTROL = { public: 'public, max-age=86400', private: 'private, max-age=300' } as const;

function keyFromParams(req: Request): string {
  const rest = (req.params as Record<string, unknown>).rest;
  const segs = Array.isArray(rest) ? rest.map(String) : typeof rest === 'string' ? rest.split('/') : [];
  return segs.join('/');
}

/** 请求是否经过 Nginx（cloudalbum_proxy.conf 设置 X-CloudAlbum-Entry；request-context 只信任回环地址来的值） */
function viaNginx(c: Container): boolean {
  return Boolean(currentContext()?.entry) || c.config.core.NODE_ENV === 'production';
}

async function serveMedia(c: Container, req: Request, res: Response): Promise<void> {
  const key = keyFromParams(req);
  if (!key || !isValidKey(key) || !/^(variants|raw|reports)\//.test(key)) throw new HttpError(404, 'NOT_FOUND', '媒体不存在');
  const visibility = visibilityOfKey(key);
  const local = asLocalStorage(c.storage);

  if (visibility === 'public') {
    const photoId = key.split('/')[1]!;
    const photo = await getPhoto(c.dbRead, photoId);
    if (!photo) throw new HttpError(404, 'NOT_FOUND', '媒体不存在');
    if (photo.status === 'BLOCKED') {
      const v = viewerOf();
      if (!v.isAdmin && v.userId !== photo.ownerId) throw new HttpError(403, 'PHOTO_BLOCKED', '照片已被拦截');
    }
  } else {
    const ok = local
      ? await local.verifyMediaSignature(key, req.query.exp, req.query.sig)
      : false;
    if (!ok && local) throw new HttpError(403, 'MEDIA_SIGNATURE_INVALID', '媒体签名无效或已过期');
    if (!local) {
      // s3：私有媒体只能经预签名 URL 访问；这里只为已登录的主人 / 管理员重签（兼容旧链接）
      const v = viewerOf();
      const owner = key.startsWith('raw/') ? key.split('/')[1] : undefined;
      if (!v.isAdmin && (!v.userId || v.userId !== owner)) throw new HttpError(403, 'FORBIDDEN', '私有媒体需要签名');
    }
  }

  const internal = c.storage.internalRedirectPath(key, visibility);
  if (internal === null) {
    // s3：302 到预签名 GET
    const url = await c.storage.createReadUrl(key, { visibility, expiresInSec: 600 });
    markPath(c.storage.meta.module, `${c.storage.meta.driver}:redirect`);
    res.set('Cache-Control', 'private, max-age=60').redirect(302, url);
    return;
  }
  const head = await c.storage.headObject(key);
  if (!head) throw new HttpError(404, 'NOT_FOUND', '媒体不存在');
  if (viaNginx(c)) {
    local?.markMediaServed('accel');
    res.set('X-Accel-Redirect', internal);
    res.set('Content-Type', head.contentType);
    res.status(200).end();
    return;
  }
  // 开发机：直接流式返回
  local?.markMediaServed('stream');
  res.set({
    'Content-Type': head.contentType || contentTypeForKey(key),
    'Content-Length': String(head.size),
    'Cache-Control': CACHE_CONTROL[visibility],
    'Last-Modified': new Date(head.lastModified).toUTCString(),
    ...(head.etag ? { ETag: head.etag } : {}),
  });
  if (head.etag && req.get('if-none-match') === head.etag) {
    res.status(304).end();
    return;
  }
  if (req.method === 'HEAD') {
    res.status(200).end();
    return;
  }
  const { body } = await c.storage.getObject(key);
  await new Promise<void>((resolve, reject) => {
    body.on('error', reject);
    res.on('close', () => {
      body.destroy();
      resolve();
    });
    body.pipe(res);
  });
}

const dayParam = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式应为 YYYY-MM-DD');
const generateBody = z.object({ day: dayParam.optional(), notify: z.boolean().optional() });

export function register(app: Express, c: Container): void {
  app.get('/media/*rest', (req, res) => serveMedia(c, req, res));   // Express 的 GET 路由同时处理 HEAD

  // ---- 日报（F13；reports/ 是 private，只有管理员能签发读取 URL）----
  app.get('/api/reports/daily', requireAdmin, async (_req, res) => {
    const page = await c.storage.list('reports/daily/');
    const media = mediaUrls(c);
    const items = await Promise.all(page.items
      .filter((o) => /reports\/daily\/\d{4}-\d{2}-\d{2}\.csv$/.test(o.key))
      .sort((a, b) => b.key.localeCompare(a.key))
      .slice(0, 90)
      .map(async (o) => ({
        day: o.key.slice('reports/daily/'.length, -4), key: o.key, size: o.size, lastModified: o.lastModified,
        url: await media.url(o.key, { visibility: 'private' }),
      })));
    noStore(res);
    res.json({ items });
  });

  app.get('/api/reports/daily/:day', requireAdmin, async (req, res) => {
    const day = parseOr400(dayParam, param(req, 'day'));
    const key = reportKey(day);
    const head = await c.storage.headObject(key);
    if (!head) throw new HttpError(404, 'REPORT_NOT_FOUND', `${day} 的日报尚未生成`);
    noStore(res);
    res.json({ day, key, size: head.size, url: await mediaUrls(c).url(key, { visibility: 'private' }) });
  });

  app.post('/api/reports/daily', requireAdmin, async (req, res) => {
    const body = parseOr400(generateBody, req.body ?? {});
    const r = await generateDailyReport({ cfg: c.config, db: c.db, storage: c.storage, queue: c.queue, notifier: c.notifier, logger: c.logger }, {
      ...(body.day ? { day: body.day } : {}), ...(body.notify !== undefined ? { notify: body.notify } : {}),
    });
    noStore(res);
    res.status(201).json({ ...r, url: await mediaUrls(c).url(r.key, { visibility: 'private' }) });
  });
}
