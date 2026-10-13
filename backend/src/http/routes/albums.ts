// backend/src/http/routes/albums.ts —— F5：相册 CRUD
//
//   GET    /api/albums               本人的相册（?userId=<id> 看别人的公开相册）→ Page<Album>；走 dbRead 与 cache.wrap
//   POST   /api/albums               {title,description?,visibility?} → 201 Album
//   GET    /api/albums/:id           → AlbumDetail {album, photos, nextCursor}（非本人只能看公开相册里 READY 的公开照片）
//   PATCH  /api/albums/:id           {title?,description?,visibility?,coverPhotoId?} → Album（仅本人）
//   DELETE /api/albums/:id           → 204（仅本人；默认相册不能删除；照片保留，album_id 置空）
// X-Compare-Bypass：cache（跳过 cache.wrap）、replica（只读查询改走主库），由 bypassGuard 校验白名单与权限。
// 照片的媒体 URL：StoragePort.createReadUrl（源站地址）+ CdnPort.mediaUrl（若有），与 MediaUrlBuilder 的规则一致
// （cdn 旁路时不改写）；生成失败时该照片的 urls 为 null，不影响相册本身。
import type { Express } from 'express';
import type { Knex } from 'knex';
import { z } from 'zod';
import type { Container } from '../../container.js';
import { HttpError, isNotImplemented } from '../../errors.js';
import { isBypassed, currentContext } from '../../observability/request-context.js';
import {
  albumIsDefault, coverPhotoOf, deleteAlbum, findAlbum, insertAlbum, listAlbumPhotos, listAlbumsByOwner, photoOwnedBy, updateAlbum,
  type AlbumPhotoRow, type AlbumRow,
} from '../../repositories/albums.js';
import { audit } from '../middleware/audit.js';
import { currentUser, requireAuth } from '../middleware/auth.js';
import { parseBody } from './auth.js';

const Visibility = z.enum(['public', 'private']);
const CreateBody = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(2000).nullable().optional(),
  visibility: Visibility.optional().default('private'),
});
const PatchBody = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(2000).nullable().optional(),
  visibility: Visibility.optional(),
  coverPhotoId: z.string().max(64).nullable().optional(),
}).refine((v) => Object.keys(v).length > 0, { message: '至少修改一个字段' });

/** 相册列表的缓存键（photos 路由在照片增删、移动相册后应 del 这些键） */
export function albumCacheKeys(ownerId: string): string[] {
  return [`albums:v1:owner:${ownerId}`, `albums:v1:public:${ownerId}`];
}

export interface AlbumView {
  id: string; ownerId: string; title: string; description: string | null; visibility: 'public' | 'private';
  coverPhotoId: string | null; coverUrl: string | null; isDefault: boolean; photoCount: number; createdAt: string; updatedAt: string;
}

type MediaVisibility = 'public' | 'private';

/** 源站 URL + CDN 改写（cdn 旁路时不改写），失败返回 null */
async function mediaUrl(c: Container, key: string | null, visibility: MediaVisibility): Promise<string | null> {
  if (!key) return null;
  try {
    const origin = await c.storage.createReadUrl(key, { visibility, expiresInSec: 3600 });
    if (isBypassed('cdn') || typeof c.cdn.mediaUrl !== 'function') return origin;
    return c.cdn.mediaUrl(key, { visibility, originUrl: origin });
  } catch {
    return null;
  }
}

export function register(app: Express, c: Container): void {
  /** 读接口：X-Compare-Bypass: replica 时改走主库 */
  const readDb = (): Knex => (isBypassed('replica') ? c.db : c.dbRead);

  const ttl = () => Math.max(0, c.runtimeConfig().feedCacheTtlSec);

  async function toView(a: AlbumRow, opts: { withCover?: boolean } = {}): Promise<AlbumView> {
    let coverPhotoId = a.cover_photo_id;
    let coverUrl: string | null = null;
    if (opts.withCover !== false) {
      const cover = await coverPhotoOf(readDb(), a).catch(() => null);
      if (cover) {
        coverPhotoId = cover.id;
        coverUrl = await mediaUrl(c, cover.thumb_key, cover.visibility === 'public' && a.visibility === 'public' ? 'public' : 'private');
      }
    }
    return {
      id: a.id, ownerId: a.owner_id, title: a.title, description: a.description, visibility: a.visibility, coverPhotoId, coverUrl,
      isDefault: albumIsDefault(a), photoCount: Number(a.photo_count ?? 0), createdAt: a.created_at, updatedAt: a.updated_at,
    };
  }

  async function photoView(p: AlbumPhotoRow, viewerIsOwner: boolean): Promise<Record<string, unknown>> {
    const vis: MediaVisibility = p.visibility === 'public' ? 'public' : 'private';
    const ready = p.status === 'READY';
    return {
      id: p.id, ownerId: p.owner_id, albumId: p.album_id, filename: p.filename, contentType: p.content_type,
      sizeBytes: p.size_bytes === null ? null : Number(p.size_bytes), status: p.status, visibility: p.visibility, title: p.title,
      caption: p.caption, width: p.width, height: p.height, dominantColor: p.dominant_color, takenAt: p.taken_at, createdAt: p.created_at,
      readyAt: p.ready_at, labels: p.labels ?? [], processedBy: p.processed_by ?? null, workflow: p.workflow ?? null,
      failureReason: viewerIsOwner ? p.failure_reason : null,
      urls: {
        thumb: ready ? await mediaUrl(c, p.thumb_key, vis) : null,
        display: ready ? await mediaUrl(c, p.display_key, vis) : null,
        original: viewerIsOwner ? await mediaUrl(c, p.raw_key, 'private') : null,
      },
    };
  }

  /** cache-aside（cache.wrap 自己处理旁路与路径段）；缓存驱动尚未实现时直接读库 */
  async function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    if (ttl() <= 0) return load();
    try {
      return await c.cache.wrap(key, ttl(), load);
    } catch (e) {
      if (isNotImplemented(e)) return load();
      throw e;
    }
  }

  async function loadOwned(id: string, userId: string): Promise<AlbumRow> {
    const album = await findAlbum(c.db, id);
    if (!album) throw new HttpError(404, 'ALBUM_NOT_FOUND', '相册不存在');
    if (album.owner_id !== userId) throw new HttpError(403, 'FORBIDDEN', '只能修改自己的相册');
    return album;
  }

  async function invalidate(ownerId: string): Promise<void> {
    try {
      await c.cache.del(albumCacheKeys(ownerId));
    } catch {
      /* 缓存是非权威端口：失效失败只会让列表最多陈旧一个 TTL */
    }
  }

  app.get('/api/albums', async (req, res) => {
    const ctx = currentContext();
    const requested = typeof req.query.userId === 'string' && req.query.userId ? req.query.userId : undefined;
    const ownerId = requested ?? ctx?.userId;
    if (!ownerId) throw new HttpError(401, 'UNAUTHENTICATED', '需要登录（或用 ?userId= 浏览别人的公开相册）');
    const own = ownerId === ctx?.userId;
    const [key] = own ? albumCacheKeys(ownerId) : albumCacheKeys(ownerId).slice(1);
    const load = async () => {
      const rows = await listAlbumsByOwner(readDb(), ownerId, { onlyPublic: !own });
      return Promise.all(rows.map((r) => toView(r)));
    };
    const items = await cached(key!, load);
    res.set('Cache-Control', 'private, no-store').json({ items, nextCursor: null });
  });

  app.post('/api/albums', requireAuth, async (req, res) => {
    const me = currentUser();
    const body = parseBody(CreateBody, req.body);
    const row = await insertAlbum(c.db, { ownerId: me.userId, title: body.title, description: body.description ?? null, visibility: body.visibility });
    await invalidate(me.userId);
    await audit(c, { action: 'album.create', targetType: 'album', targetId: row.id, details: { visibility: row.visibility } });
    res.status(201).json(await toView({ ...row, photo_count: 0 }, { withCover: false }));
  });

  app.get('/api/albums/:id', async (req, res) => {
    const ctx = currentContext();
    const album = await findAlbum(readDb(), String(req.params.id));
    const viewerIsOwner = Boolean(album && ctx?.userId && album.owner_id === ctx.userId);
    if (!album || (!viewerIsOwner && album.visibility !== 'public' && !ctx?.isAdmin)) {
      throw new HttpError(404, 'ALBUM_NOT_FOUND', '相册不存在或不公开');
    }
    const limit = Math.min(Math.max(Number(req.query.limit ?? 50) || 50, 1), 200);
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
    const page = await listAlbumPhotos(readDb(), album.id, { viewerIsOwner: viewerIsOwner || Boolean(ctx?.isAdmin), limit, ...(cursor ? { cursor } : {}) });
    const photos = await Promise.all(page.items.map((p) => photoView(p, viewerIsOwner)));
    res.set('Cache-Control', 'private, no-store').json({ album: await toView(album), photos, nextCursor: page.nextCursor });
  });

  app.patch('/api/albums/:id', requireAuth, async (req, res) => {
    const me = currentUser();
    const album = await loadOwned(String(req.params.id), me.userId);
    const body = parseBody(PatchBody, req.body);
    if (body.coverPhotoId && !(await photoOwnedBy(c.db, body.coverPhotoId, me.userId))) {
      throw new HttpError(400, 'INVALID_COVER', '封面必须是自己的照片');
    }
    await updateAlbum(c.db, album.id, {
      ...(body.title !== undefined ? { title: body.title } : {}),
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(body.visibility !== undefined ? { visibility: body.visibility } : {}),
      ...(body.coverPhotoId !== undefined ? { cover_photo_id: body.coverPhotoId } : {}),
    });
    await invalidate(me.userId);
    await audit(c, { action: 'album.update', targetType: 'album', targetId: album.id, details: { fields: Object.keys(body) } });
    res.json(await toView((await findAlbum(c.db, album.id))!));
  });

  app.delete('/api/albums/:id', requireAuth, async (req, res) => {
    const me = currentUser();
    const album = await loadOwned(String(req.params.id), me.userId);
    if (albumIsDefault(album)) throw new HttpError(409, 'DEFAULT_ALBUM', '默认相册不能删除');
    await deleteAlbum(c.db, album.id);
    await invalidate(me.userId);
    await audit(c, { action: 'album.delete', targetType: 'album', targetId: album.id });
    res.status(204).end();
  });
}
