// backend/src/services/share.ts —— 带有效期的分享链接（F11，03#social-store 第 1 节）
//
// - 创建：只有照片主人（或管理员）能为 READY 的照片创建；有效期默认 24 小时、上限 30 天（SocialStorePort 驱动内夹紧）；
// - 打开：SocialStorePort.resolveShare() 自行比较 expiresAt（过期或不存在 → 410 SHARE_GONE）；照片已删除或被拦截同样 410；
//   不需要登录，私有照片也能经分享链接查看（这正是分享的意义）；媒体 URL 由 MediaUrlBuilder 生成（衍生图为公开 URL）；
// - 物理删除由定时任务 share.cleanup 执行（db 驱动；dynamodb 交给 TTL）。
import type { Container } from '../container.js';
import { HttpError } from '../errors.js';
import { getPhoto } from '../repositories/photos.js';
import { presentPhotos, type PhotoDto, type Viewer } from './feed.js';

export interface ShareDto { token: string; photoId: string; createdAt: string; expiresAt: string; url: string; apiUrl: string }

export function shareUrls(c: Container, token: string): { url: string; apiUrl: string } {
  const base = c.config.core.APP_BASE_URL.replace(/\/+$/, '');
  return { url: `${base}/s/${encodeURIComponent(token)}`, apiUrl: `/api/shares/${encodeURIComponent(token)}` };
}

export async function createShareLink(c: Container, viewer: Viewer & { userId: string }, photoId: string, ttlSec?: number): Promise<ShareDto> {
  const photo = await getPhoto(c.db, photoId);
  if (!photo || (photo.ownerId !== viewer.userId && !viewer.isAdmin)) throw new HttpError(404, 'PHOTO_NOT_FOUND', '照片不存在');
  if (photo.status !== 'READY') throw new HttpError(409, 'PHOTO_NOT_READY', `照片当前状态为 ${photo.status}，不能分享`);
  const link = await c.social.createShare({ photoId, createdBy: viewer.userId, ttlSec: ttlSec ?? 24 * 3600 });
  return { token: link.token, photoId, createdAt: link.createdAt, expiresAt: link.expiresAt, ...shareUrls(c, link.token) };
}

export async function openShare(c: Container, token: string, viewer: Viewer): Promise<{ share: { token: string; expiresAt: string; createdAt: string }; photo: PhotoDto }> {
  const link = await c.social.resolveShare(token);
  if (!link) throw new HttpError(410, 'SHARE_GONE', '分享链接不存在或已过期');
  const photo = await getPhoto(c.dbRead, link.photoId);
  if (!photo || photo.status !== 'READY') throw new HttpError(410, 'SHARE_GONE', '分享的照片已不可用');
  const [dto] = await presentPhotos(c, [photo], viewer);
  return { share: { token: link.token, expiresAt: link.expiresAt, createdAt: link.createdAt }, photo: dto! };
}
