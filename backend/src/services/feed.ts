// backend/src/services/feed.ts —— 时间线（F5）与照片的对外表示（PhotoDto）
//
// cache-aside（03#cache 第 1 节）：
//   - 键：feed:{u:<userId>}:v<ver>:p<cursor>:n<limit>（我的时间线）、feed:{pub}:v<ver>:p<cursor>:n<limit>（公共时间线）；
//     相册内照片 album:{a:<albumId>}:v<ver>:photos:p<cursor>:n<limit>；
//   - 失效：写操作对版本号键 ver:{u:<id>}、ver:{a:<id>}、ver:{pub} 执行 incr（7 天），旧版本的键自然过期；
//   - TTL：运行时配置 feedCacheTtlSec（热更新）；
//   - 只缓存逻辑数据（照片元数据与存储键），从不缓存 URL；点赞 / 评论计数不缓存（每次 social.getCounters 批量读取）；
//   - X-Compare-Bypass: cache 由 CachePort.wrap 处理；X-Compare-Bypass: replica 时只读查询改走主库。
import type { Knex } from 'knex';
import type { Container } from '../container.js';
import { HttpError } from '../errors.js';
import { isBypassed } from '../observability/request-context.js';
import type { CachePort } from '../ports/cache.js';
import {
  getAlbumRef, listFeed, searchByTag, userNames, type Photo, type PhotoLabel, type PhotoStatus, type ProcessedBy, type Visibility,
} from '../repositories/photos.js';
import { mediaUrls, type PhotoUrls } from './media-url.js';

export const VERSION_TTL_SEC = 7 * 86400;

export interface Viewer { userId?: string; isAdmin: boolean }

export const versionKey = {
  user: (userId: string) => `ver:{u:${userId}}`,
  album: (albumId: string) => `ver:{a:${albumId}}`,
  public: () => 'ver:{pub}',
};

/** 相册列表缓存的键（与 http/routes/albums.ts 的 albumCacheKeys 一致：照片增删改会改变封面与照片数） */
export function albumListCacheKeys(ownerId: string): string[] {
  return [`albums:v1:owner:${ownerId}`, `albums:v1:public:${ownerId}`];
}

/** 照片的写操作之后：让相关时间线（版本号 +1）与相册列表（删除键）的缓存失效。缓存是非权威端口，失败只忽略 */
export async function bumpFeedVersions(cache: CachePort | undefined, p: { ownerId: string; albumId?: string | null }): Promise<void> {
  if (!cache) return;
  const keys = [versionKey.user(p.ownerId), versionKey.public(), ...(p.albumId ? [versionKey.album(p.albumId)] : [])];
  await Promise.all([
    ...keys.map((k) => cache.incr(k, VERSION_TTL_SEC).catch(() => 0)),
    cache.del(albumListCacheKeys(p.ownerId)).catch(() => undefined),
  ]);
}

async function currentVersion(cache: CachePort, key: string): Promise<number> {
  try {
    const r = await cache.get<number>(key);
    return typeof r.value === 'number' ? r.value : Number(r.value ?? 0) || 0;
  } catch {
    return 0;
  }
}

/** 照片的对外表示（URL 在这里生成；计数与“我是否点过赞”每次实时读取） */
export interface PhotoDto {
  id: string;
  ownerId: string;
  owner: { id: string; displayName: string };
  albumId: string | null;
  status: PhotoStatus;
  visibility: Visibility;
  title: string | null;
  caption: string | null;
  filename: string;
  contentType: string;
  sizeBytes: number | null;
  width: number | null;
  height: number | null;
  dominantColor: string | null;
  takenAt: string | null;
  createdAt: string;
  updatedAt: string;
  readyAt: string | null;
  failureReason?: string | null;
  labels: PhotoLabel[];
  processedBy: ProcessedBy | null;
  urls: PhotoUrls;
  counters: { likes: number; comments: number };
  likedByMe: boolean;
  isOwner: boolean;
}

/** 缓存里存放的照片（去掉密文等不该进缓存的字段） */
function cacheable(p: Photo): Photo {
  return { ...p, locationEnc: null };
}

export interface PresentOptions { db?: Knex; includeOriginal?: boolean; withSocial?: boolean }

/** Photo[] → PhotoDto[]：批量补齐主人显示名、计数、点赞状态与媒体 URL */
export async function presentPhotos(c: Container, photos: Photo[], viewer: Viewer, opts: PresentOptions = {}): Promise<PhotoDto[]> {
  if (!photos.length) return [];
  const ids = photos.map((p) => p.id);
  const db = opts.db ?? c.dbRead;
  const withSocial = opts.withSocial !== false;
  const [names, counters, liked] = await Promise.all([
    userNames(db, photos.map((p) => p.ownerId)),
    withSocial ? c.social.getCounters(ids) : Promise.resolve({} as Record<string, { likes: number; comments: number }>),
    withSocial && viewer.userId ? c.social.likedBy(ids, viewer.userId) : Promise.resolve(new Set<string>()),
  ]);
  const media = mediaUrls(c);
  return Promise.all(photos.map(async (p) => {
    const isOwner = Boolean(viewer.userId && viewer.userId === p.ownerId);
    const showMedia = p.status === 'READY' || (p.status === 'BLOCKED' && (isOwner || viewer.isAdmin));
    const urls = showMedia
      ? await media.photoUrls(p, { includeOriginal: Boolean(opts.includeOriginal && (isOwner || viewer.isAdmin)) })
      : { thumb: null, display: null };
    return {
      id: p.id, ownerId: p.ownerId, owner: { id: p.ownerId, displayName: names.get(p.ownerId) ?? '' }, albumId: p.albumId,
      status: p.status, visibility: p.visibility, title: p.title, caption: p.caption, filename: p.filename,
      contentType: p.contentType, sizeBytes: p.sizeBytes, width: p.width, height: p.height, dominantColor: p.dominantColor,
      takenAt: p.takenAt, createdAt: p.createdAt, updatedAt: p.updatedAt, readyAt: p.readyAt,
      ...(isOwner || viewer.isAdmin ? { failureReason: p.failureReason } : {}),
      labels: p.labels, processedBy: p.processedBy, urls,
      counters: counters[p.id] ?? { likes: 0, comments: 0 }, likedByMe: liked.has(p.id), isOwner,
    };
  }));
}

/** 查看权限：主人、管理员，或公开且 READY */
export function canView(p: Photo, viewer: Viewer): boolean {
  if (viewer.isAdmin) return true;
  if (viewer.userId && viewer.userId === p.ownerId) return true;
  return p.visibility === 'public' && p.status === 'READY';
}

export interface FeedPage { items: PhotoDto[]; next?: string; scope: string }

/** GET /api/feed：scope=mine（我的全部照片，含处理中）| public（所有人公开且 READY 的照片） */
export async function getFeed(c: Container, viewer: Viewer, q: { scope: 'mine' | 'public'; limit: number; cursor?: string }): Promise<FeedPage> {
  if (q.scope === 'mine' && !viewer.userId) throw new HttpError(401, 'UNAUTHENTICATED', '需要登录');
  const db = isBypassed('replica') ? c.db : c.dbRead;
  const verKey = q.scope === 'mine' ? versionKey.user(viewer.userId!) : versionKey.public();
  const ver = await currentVersion(c.cache, verKey);
  const scopeKey = q.scope === 'mine' ? `{u:${viewer.userId}}` : '{pub}';
  const key = `feed:${scopeKey}:v${ver}:p${q.cursor ?? '0'}:n${q.limit}`;
  const ttl = c.runtimeConfig().feedCacheTtlSec;
  const page = await c.cache.wrap(key, ttl, async () => {
    const r = await listFeed(db, { scope: q.scope, ...(viewer.userId ? { userId: viewer.userId } : {}), limit: q.limit, ...(q.cursor ? { cursor: q.cursor } : {}) });
    return { items: r.items.map(cacheable), ...(r.next ? { next: r.next } : {}) };
  });
  return { scope: q.scope, items: await presentPhotos(c, page.items, viewer, { db }), ...(page.next ? { next: page.next } : {}) };
}

/** 相册内的照片（GET /api/photos?albumId=）：相册主人看到全部，其他人只看到公开且 READY 的照片 */
export async function getAlbumPhotos(c: Container, viewer: Viewer, q: { albumId: string; limit: number; cursor?: string }): Promise<FeedPage> {
  const db = isBypassed('replica') ? c.db : c.dbRead;
  const album = await getAlbumRef(db, q.albumId);
  const isOwner = Boolean(album && viewer.userId === album.ownerId);
  if (!album || (!isOwner && !viewer.isAdmin && album.visibility !== 'public')) throw new HttpError(404, 'ALBUM_NOT_FOUND', '相册不存在');
  const ver = await currentVersion(c.cache, versionKey.album(q.albumId));
  const key = `album:{a:${q.albumId}}:v${ver}:photos:${isOwner || viewer.isAdmin ? 'all' : 'pub'}:p${q.cursor ?? '0'}:n${q.limit}`;
  const page = await c.cache.wrap(key, 300, async () => {
    const r = await listFeed(db, { scope: 'album', albumId: q.albumId, viewerIsOwner: isOwner || viewer.isAdmin, limit: q.limit, ...(q.cursor ? { cursor: q.cursor } : {}) });
    return { items: r.items.map(cacheable), ...(r.next ? { next: r.next } : {}) };
  });
  return { scope: 'album', items: await presentPhotos(c, page.items, viewer, { db }), ...(page.next ? { next: page.next } : {}) };
}

/** GET /api/search?tag=…：走 photo_labels 的索引，不缓存 */
export async function searchPhotos(c: Container, viewer: Viewer, q: { tag: string; limit: number; cursor?: string }): Promise<FeedPage> {
  const r = await searchByTag(c.dbRead, {
    tag: q.tag, ...(viewer.userId ? { viewerId: viewer.userId } : {}), isAdmin: viewer.isAdmin, limit: q.limit, ...(q.cursor ? { cursor: q.cursor } : {}),
  });
  return { scope: 'search', items: await presentPhotos(c, r.items, viewer), ...(r.next ? { next: r.next } : {}) };
}
