// backend/src/repositories/albums.ts —— albums 表（F2 默认相册、F5 相册 CRUD）
//
// 相册内照片的计数 / 封面 / 列表只读 photos 表（photos 的写入由 photos 仓储负责）。
import { randomUUID } from 'node:crypto';
import type { Knex } from 'knex';
import { boolIn, countOf, jsonIn, nowIso } from '../db/dialect.js';
import { decodeCursor, encodeCursor } from './users.js';

type Db = Knex | Knex.Transaction;
export type AlbumVisibility = 'public' | 'private';

export interface AlbumRow {
  id: string;
  owner_id: string;
  title: string;
  description: string | null;
  visibility: AlbumVisibility;
  cover_photo_id: string | null;
  is_default: boolean | number;
  created_at: string;
  updated_at: string;
  photo_count?: number | string | null;
}

export const DEFAULT_ALBUM_TITLE = '默认相册';

export async function insertAlbum(db: Db, input: {
  ownerId: string; title: string; description?: string | null; visibility?: AlbumVisibility; isDefault?: boolean; id?: string;
}): Promise<AlbumRow> {
  const now = nowIso();
  const row: AlbumRow = {
    id: input.id ?? randomUUID(),
    owner_id: input.ownerId,
    title: input.title,
    description: input.description ?? null,
    visibility: input.visibility ?? 'private',
    cover_photo_id: null,
    is_default: input.isDefault ?? false,
    created_at: now,
    updated_at: now,
  };
  await db('albums').insert(row);
  return row;
}

/** F2：注册事务内建默认相册（幂等：已有默认相册时直接返回它） */
export async function ensureDefaultAlbum(db: Db, ownerId: string, title = DEFAULT_ALBUM_TITLE): Promise<AlbumRow> {
  const existing = (await db('albums').where({ owner_id: ownerId, is_default: true }).first()) as AlbumRow | undefined;
  if (existing) return existing;
  return insertAlbum(db, { ownerId, title, isDefault: true });
}

export async function findAlbum(db: Db, id: string): Promise<AlbumRow | undefined> {
  const row = (await db('albums').where({ id }).first()) as AlbumRow | undefined;
  if (!row) return undefined;
  return { ...row, photo_count: await countAlbumPhotos(db, id) };
}

export async function countAlbumPhotos(db: Db, albumId: string): Promise<number> {
  return countOf(await db('photos').where({ album_id: albumId }).count({ count: '*' }).first());
}

/** 某个用户的相册（含照片数）；onlyPublic = 浏览别人的相册时只看公开的 */
export async function listAlbumsByOwner(db: Db, ownerId: string, opts: { onlyPublic?: boolean } = {}): Promise<AlbumRow[]> {
  const counts = db('photos').select('album_id').count({ photo_count: '*' }).whereNotNull('album_id').groupBy('album_id').as('pc');
  const q = db('albums as a')
    .leftJoin(counts, 'pc.album_id', 'a.id')
    .where('a.owner_id', ownerId)
    .select('a.*', 'pc.photo_count')
    .orderBy([{ column: 'a.is_default', order: 'desc' }, { column: 'a.created_at', order: 'desc' }, { column: 'a.id', order: 'desc' }]);
  if (opts.onlyPublic) q.andWhere('a.visibility', 'public');
  return (await q) as AlbumRow[];
}

export type AlbumPatch = Partial<{ title: string; description: string | null; visibility: AlbumVisibility; cover_photo_id: string | null }>;

export async function updateAlbum(db: Db, id: string, patch: AlbumPatch): Promise<number> {
  return db('albums').where({ id }).update({ ...patch, updated_at: nowIso() });
}

/** 删除相册：照片的 album_id 由外键 ON DELETE SET NULL 置空（照片本身保留） */
export async function deleteAlbum(db: Db, id: string): Promise<number> {
  return db.transaction(async (trx) => {
    await trx('photos').where({ album_id: id }).update({ album_id: null, updated_at: nowIso() });
    return Number(await trx('albums').where({ id }).del());
  });
}

/** 照片是否属于该用户（设置封面时校验） */
export async function photoOwnedBy(db: Db, photoId: string, ownerId: string): Promise<boolean> {
  const row = await db('photos').where({ id: photoId, owner_id: ownerId }).first('id');
  return Boolean(row);
}

export interface AlbumPhotoRow {
  id: string; owner_id: string; album_id: string | null; raw_key: string; filename: string; content_type: string;
  size_bytes: number | string | null; status: string; visibility: AlbumVisibility; title: string | null; caption: string | null;
  thumb_key: string | null; display_key: string | null; width: number | null; height: number | null; dominant_color: string | null;
  taken_at: string | null; labels: unknown; processed_by: unknown; workflow: unknown; failure_reason: string | null;
  created_at: string; ready_at: string | null;
}

/** 相册详情页的照片（新的在前）；非本人只看 READY 且公开的照片 */
export async function listAlbumPhotos(db: Db, albumId: string, opts: { viewerIsOwner: boolean; limit?: number; cursor?: string }): Promise<{ items: AlbumPhotoRow[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const q = db('photos').where({ album_id: albumId });
  if (!opts.viewerIsOwner) q.andWhere({ status: 'READY', visibility: 'public' });
  const cur = decodeCursor(opts.cursor);
  if (cur) q.andWhere((w) => w.where('created_at', '<', cur.ts).orWhere((w2) => w2.where('created_at', '=', cur.ts).andWhere('id', '<', cur.id)));
  const rows = (await q.orderBy([{ column: 'created_at', order: 'desc' }, { column: 'id', order: 'desc' }]).limit(limit + 1)) as AlbumPhotoRow[];
  const items = rows.slice(0, limit).map((r) => ({
    ...r,
    labels: jsonIn(r.labels, null),
    processed_by: jsonIn(r.processed_by, null),
    workflow: jsonIn(r.workflow, null),
  }));
  const last = items[items.length - 1];
  return { items, nextCursor: rows.length > limit && last ? encodeCursor(last.created_at, last.id) : null };
}

/** 封面：显式设置的 cover_photo_id，否则取最新一张 READY 照片 */
export async function coverPhotoOf(db: Db, album: Pick<AlbumRow, 'id' | 'cover_photo_id'>): Promise<{ id: string; thumb_key: string | null; visibility: AlbumVisibility } | null> {
  const q = db('photos').where({ album_id: album.id, status: 'READY' });
  if (album.cover_photo_id) q.andWhere({ id: album.cover_photo_id });
  const row = (await q.orderBy('created_at', 'desc').first('id', 'thumb_key', 'visibility')) as
    { id: string; thumb_key: string | null; visibility: AlbumVisibility } | undefined;
  return row ?? null;
}

export function albumIsDefault(a: Pick<AlbumRow, 'is_default'>): boolean {
  return boolIn(a.is_default);
}
