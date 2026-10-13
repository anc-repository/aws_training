// backend/src/repositories/photos.ts —— photos、photo_labels、moderation_results 表（F5–F8）
//
// - 只存逻辑键（raw/<userId>/<photoId>.<ext>、variants/<photoId>/…），URL 在响应时由 MediaUrlBuilder 生成（原则 7）。
// - “状态只前进”的写回（04#image-processing 第 3 节）：READY 可覆盖 UPLOADING / PROCESSING / FAILED（迟到的成功也能恢复），
//   永不覆盖 READY / BLOCKED；ImageFailure 只把 UPLOADING / PROCESSING 改为 FAILED。写回结果（applied、ignored-duplicate、
//   ignored-stale）由本层返回，供调用方计数，不进入端口签名。
// - 时间一律 ISO 8601 UTC 字符串（db/dialect.ts）。
import type { Knex } from 'knex';
import { boolIn, countOf, jsonIn, jsonOut, nowIso } from '../db/dialect.js';
import type { ImageFailure, ImageResult } from '../ports/image-processor.js';
import type { TagResult } from '../ports/tagger.js';

export type PhotoStatus = 'UPLOADING' | 'PROCESSING' | 'READY' | 'FAILED' | 'BLOCKED';
export type Visibility = 'public' | 'private';
export type ApplyOutcome = 'applied' | 'ignored-duplicate' | 'ignored-stale' | 'not-found';

export interface PhotoLabel { name: string; confidence: number; source: 'basic' | 'rekognition' }
export interface ProcessedBy { driver: 'inline' | 'worker' | 'lambda' | string; durationMs: number; host: string; coldStart?: boolean }

export interface Photo {
  id: string;
  ownerId: string;
  albumId: string | null;
  rawKey: string;
  filename: string;
  contentType: string;
  sizeBytes: number | null;
  status: PhotoStatus;
  visibility: Visibility;
  title: string | null;
  caption: string | null;
  thumbKey: string | null;
  displayKey: string | null;
  width: number | null;
  height: number | null;
  dominantColor: string | null;
  takenAt: string | null;
  labels: PhotoLabel[];
  processedBy: ProcessedBy | null;
  workflow: Record<string, unknown> | null;
  processingStartedAt: string | null;
  processingAttempts: number;
  readyAt: string | null;
  failureReason: string | null;
  locationEnc: string | null;
  createdAt: string;
  updatedAt: string;
}

type Row = Record<string, unknown>;

function toPhoto(r: Row): Photo {
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  return {
    id: String(r.id),
    ownerId: String(r.owner_id),
    albumId: (r.album_id as string | null) ?? null,
    rawKey: String(r.raw_key),
    filename: String(r.filename ?? ''),
    contentType: String(r.content_type),
    sizeBytes: num(r.size_bytes),
    status: r.status as PhotoStatus,
    visibility: (r.visibility as Visibility) ?? 'private',
    title: (r.title as string | null) ?? null,
    caption: (r.caption as string | null) ?? null,
    thumbKey: (r.thumb_key as string | null) ?? null,
    displayKey: (r.display_key as string | null) ?? null,
    width: num(r.width),
    height: num(r.height),
    dominantColor: (r.dominant_color as string | null) ?? null,
    takenAt: (r.taken_at as string | null) ?? null,
    labels: jsonIn<PhotoLabel[]>(r.labels, []) ?? [],
    processedBy: jsonIn<ProcessedBy>(r.processed_by, null),
    workflow: jsonIn<Record<string, unknown>>(r.workflow, null),
    processingStartedAt: (r.processing_started_at as string | null) ?? null,
    processingAttempts: Number(r.processing_attempts ?? 0),
    readyAt: (r.ready_at as string | null) ?? null,
    failureReason: (r.failure_reason as string | null) ?? null,
    locationEnc: (r.location_enc as string | null) ?? null,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

// ---------------------------------------------------------------------------------------------
// 基本读写
// ---------------------------------------------------------------------------------------------
export interface NewPhoto {
  id: string; ownerId: string; albumId: string | null; rawKey: string; filename: string; contentType: string;
  sizeBytes: number | null; visibility: Visibility; title?: string | null; caption?: string | null;
}

export async function insertPhoto(db: Knex, p: NewPhoto): Promise<Photo> {
  const now = nowIso();
  await db('photos').insert({
    id: p.id, owner_id: p.ownerId, album_id: p.albumId, raw_key: p.rawKey, filename: p.filename.slice(0, 255),
    content_type: p.contentType, size_bytes: p.sizeBytes, status: 'UPLOADING', visibility: p.visibility,
    title: p.title ?? null, caption: p.caption ?? null, processing_attempts: 0, created_at: now, updated_at: now,
  });
  return (await getPhoto(db, p.id))!;
}

export async function getPhoto(db: Knex, id: string): Promise<Photo | undefined> {
  const r = (await db('photos').where({ id }).first()) as Row | undefined;
  return r ? toPhoto(r) : undefined;
}

export async function getPhotos(db: Knex, ids: readonly string[]): Promise<Photo[]> {
  if (!ids.length) return [];
  const rows = (await db('photos').whereIn('id', [...new Set(ids)])) as Row[];
  return rows.map(toPhoto);
}

export interface PhotoPatch { title?: string | null; caption?: string | null; visibility?: Visibility; albumId?: string | null }

export async function updatePhoto(db: Knex, id: string, patch: PhotoPatch): Promise<Photo | undefined> {
  const row: Row = { updated_at: nowIso() };
  if (patch.title !== undefined) row.title = patch.title;
  if (patch.caption !== undefined) row.caption = patch.caption;
  if (patch.visibility !== undefined) row.visibility = patch.visibility;
  if (patch.albumId !== undefined) row.album_id = patch.albumId;
  await db('photos').where({ id }).update(row);
  return getPhoto(db, id);
}

export async function deletePhotoRow(db: Knex, id: string): Promise<boolean> {
  return (await db('photos').where({ id }).del()) > 0;
}

export async function setSizeBytes(db: Knex, id: string, size: number, rawKey?: string): Promise<void> {
  await db('photos').where({ id }).update({ size_bytes: size, ...(rawKey ? { raw_key: rawKey } : {}), updated_at: nowIso() });
}

// ---------------------------------------------------------------------------------------------
// 状态机
// ---------------------------------------------------------------------------------------------
/** complete：UPLOADING / PROCESSING / FAILED → PROCESSING，记下开始时间并累加尝试次数。已 READY / BLOCKED 返回 false */
export async function markProcessing(db: Knex, id: string): Promise<boolean> {
  const n = await db('photos').where({ id }).whereIn('status', ['UPLOADING', 'PROCESSING', 'FAILED']).update({
    status: 'PROCESSING', processing_started_at: nowIso(), processing_attempts: db.raw('processing_attempts + 1'),
    failure_reason: null, updated_at: nowIso(),
  });
  return n > 0;
}

/** 权威的图片处理端口拒绝受理（例如 lambda 档 error）：PROCESSING 退回 UPLOADING，客户端稍后可重试 complete */
export async function revertToUploading(db: Knex, id: string): Promise<boolean> {
  const n = await db('photos').where({ id, status: 'PROCESSING' }).update({ status: 'UPLOADING', processing_started_at: null, updated_at: nowIso() });
  return n > 0;
}

/** 重新提交时只刷新开始时间与次数（对账任务） */
export async function touchProcessing(db: Knex, id: string): Promise<boolean> {
  const n = await db('photos').where({ id, status: 'PROCESSING' }).update({
    processing_started_at: nowIso(), processing_attempts: db.raw('processing_attempts + 1'), updated_at: nowIso(),
  });
  return n > 0;
}

/** 写回成功结果（幂等，“状态只前进”） */
export async function applyImageResult(db: Knex, r: ImageResult, extra: { locationEnc?: string | null } = {}): Promise<ApplyOutcome> {
  const thumb = r.variants.find((v) => v.name === 'thumb_200');
  const display = r.variants.find((v) => v.name === 'display_1080');
  const now = nowIso();
  const n = await db('photos').where({ id: r.photoId }).whereIn('status', ['UPLOADING', 'PROCESSING', 'FAILED']).update({
    status: 'READY',
    thumb_key: thumb?.key ?? null,
    display_key: display?.key ?? null,
    width: r.meta.width,
    height: r.meta.height,
    dominant_color: r.meta.dominantColor ?? null,
    taken_at: r.meta.takenAt ?? null,
    processed_by: jsonOut(r.processedBy),
    ready_at: now,
    failure_reason: null,
    ...(extra.locationEnc !== undefined ? { location_enc: extra.locationEnc } : {}),
    updated_at: now,
  });
  if (n > 0) return 'applied';
  return outcomeForIgnored(db, r.photoId);
}

/** 写回永久错误：只把 UPLOADING / PROCESSING 改为 FAILED（不覆盖 READY / BLOCKED） */
export async function applyImageFailure(db: Knex, f: ImageFailure): Promise<ApplyOutcome> {
  return markFailed(db, f.photoId, f.error, f.processedBy);
}

export async function markFailed(db: Knex, id: string, reason: string, processedBy?: ProcessedBy): Promise<ApplyOutcome> {
  const n = await db('photos').where({ id }).whereIn('status', ['UPLOADING', 'PROCESSING']).update({
    status: 'FAILED', failure_reason: reason.slice(0, 2000),
    ...(processedBy ? { processed_by: jsonOut(processedBy) } : {}), updated_at: nowIso(),
  });
  if (n > 0) return 'applied';
  return outcomeForIgnored(db, id);
}

async function outcomeForIgnored(db: Knex, id: string): Promise<ApplyOutcome> {
  const cur = (await db('photos').select('status').where({ id }).first()) as { status?: PhotoStatus } | undefined;
  if (!cur) return 'not-found';
  return cur.status === 'READY' || cur.status === 'FAILED' ? 'ignored-duplicate' : 'ignored-stale';
}

/** 对账：衍生图已经存在（处理完成但写回丢失）→ 直接补记 READY（宽高等元数据保持原值） */
export async function recoverReady(db: Knex, id: string, keys: { thumbKey: string | null; displayKey: string | null }): Promise<boolean> {
  const now = nowIso();
  const n = await db('photos').where({ id, status: 'PROCESSING' }).update({
    status: 'READY', thumb_key: keys.thumbKey, display_key: keys.displayKey, ready_at: now, failure_reason: null, updated_at: now,
  });
  return n > 0;
}

/** EXIF GPS 的密文（CryptoPort 信封加密，ca1.* 序列化） */
export async function setLocationEnc(db: Knex, id: string, enc: string | null): Promise<void> {
  await db('photos').where({ id }).update({ location_enc: enc, updated_at: nowIso() });
}

/** 审核结论：READY → BLOCKED（block），或管理员恢复 BLOCKED → READY */
export async function setBlocked(db: Knex, id: string, blocked: boolean): Promise<boolean> {
  const n = await db('photos').where({ id, status: blocked ? 'READY' : 'BLOCKED' })
    .update({ status: blocked ? 'BLOCKED' : 'READY', updated_at: nowIso() });
  return n > 0;
}

export async function findStuckProcessing(db: Knex, before: Date, limit = 100): Promise<Photo[]> {
  const rows = (await db('photos').where({ status: 'PROCESSING' }).where('processing_started_at', '<', before.toISOString())
    .orderBy('processing_started_at', 'asc').limit(limit)) as Row[];
  return rows.map(toPhoto);
}

export async function findStaleUploading(db: Knex, before: Date, limit = 100): Promise<Photo[]> {
  const rows = (await db('photos').where({ status: 'UPLOADING' }).where('created_at', '<', before.toISOString())
    .orderBy('created_at', 'asc').limit(limit)) as Row[];
  return rows.map(toPhoto);
}

export async function countByStatus(db: Knex, status: PhotoStatus, opts: { startedBefore?: Date } = {}): Promise<number> {
  const q = db('photos').where({ status });
  if (opts.startedBefore) q.where('processing_started_at', '<', opts.startedBefore.toISOString());
  return countOf(await q.count({ count: '*' }).first());
}

export async function setWorkflow(db: Knex, id: string, workflow: Record<string, unknown>): Promise<void> {
  await db('photos').where({ id }).update({ workflow: jsonOut(workflow), updated_at: nowIso() });
}

// ---------------------------------------------------------------------------------------------
// 标签与审核（tagging）
// ---------------------------------------------------------------------------------------------
/** 写入本次分析的标签（同一 source 的旧标签先删除），并冗余一份到 photos.labels；审核结论写 moderation_results */
export async function saveTagResult(db: Knex, photoId: string, r: TagResult): Promise<void> {
  const now = nowIso();
  const dedup = new Map<string, PhotoLabel>();
  for (const l of r.labels) {
    const k = `${l.source}:${l.name}`;
    const prev = dedup.get(k);
    if (!prev || prev.confidence < l.confidence) dedup.set(k, { name: l.name.slice(0, 128), confidence: l.confidence, source: l.source });
  }
  const labels = [...dedup.values()];
  const sources = [...new Set(labels.map((l) => l.source))];
  await db.transaction(async (trx) => {
    if (sources.length) await trx('photo_labels').where({ photo_id: photoId }).whereIn('source', sources).del();
    for (let i = 0; i < labels.length; i += 50) {
      const chunk = labels.slice(i, i + 50).map((l) => ({ photo_id: photoId, name: l.name, confidence: l.confidence, source: l.source, created_at: now }));
      if (chunk.length) await trx('photo_labels').insert(chunk);
    }
    const all = (await trx('photo_labels').where({ photo_id: photoId }).orderBy([{ column: 'source', order: 'asc' }, { column: 'confidence', order: 'desc' }])) as Row[];
    await trx('photos').where({ id: photoId }).update({
      labels: jsonOut(all.map((x) => ({ name: x.name, confidence: Number(x.confidence), source: x.source }))), updated_at: now,
    });
    await trx('moderation_results').insert({
      photo_id: photoId, verdict: r.moderation.verdict, labels: jsonOut(r.moderation.labels), analyzed_by: jsonOut(r.analyzedBy), created_at: now,
    }).onConflict('photo_id').merge(['verdict', 'labels', 'analyzed_by', 'created_at']);
  });
}

export async function getLabels(db: Knex, photoId: string): Promise<PhotoLabel[]> {
  const rows = (await db('photo_labels').where({ photo_id: photoId }).orderBy('confidence', 'desc')) as Row[];
  return rows.map((r) => ({ name: String(r.name), confidence: Number(r.confidence), source: r.source as PhotoLabel['source'] }));
}

export async function getModeration(db: Knex, photoId: string): Promise<{ verdict: string; labels: unknown; analyzedBy: unknown } | null> {
  const r = (await db('moderation_results').where({ photo_id: photoId }).first()) as Row | undefined;
  return r ? { verdict: String(r.verdict), labels: jsonIn(r.labels, []), analyzedBy: jsonIn(r.analyzed_by, null) } : null;
}

// ---------------------------------------------------------------------------------------------
// 列表、时间线与搜索（游标 = created_at|id，倒序）
// ---------------------------------------------------------------------------------------------
export interface FeedQuery {
  scope: 'mine' | 'public' | 'album';
  userId?: string;
  albumId?: string;
  /** album 范围内：查看者不是相册主人时只返回公开且 READY 的照片 */
  viewerIsOwner?: boolean;
  limit: number;
  cursor?: string;
}

export function encodeCursor(p: { createdAt: string; id: string }): string {
  return Buffer.from(`${p.createdAt}|${p.id}`, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string | undefined): { createdAt: string; id: string } | null {
  if (!cursor) return null;
  try {
    const [createdAt, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
    return createdAt && id ? { createdAt, id } : null;
  } catch {
    return null;
  }
}

function applyCursor(q: Knex.QueryBuilder, cursor: string | undefined): void {
  const c = decodeCursor(cursor);
  if (!c) return;
  q.where((w) => {
    w.where('created_at', '<', c.createdAt).orWhere((w2) => w2.where('created_at', '=', c.createdAt).andWhere('id', '<', c.id));
  });
}

export async function listFeed(db: Knex, q: FeedQuery): Promise<{ items: Photo[]; next?: string }> {
  const limit = Math.max(1, Math.min(100, q.limit));
  const qb = db('photos');
  if (q.scope === 'mine') {
    qb.where({ owner_id: q.userId ?? '' });
  } else if (q.scope === 'public') {
    qb.where({ visibility: 'public', status: 'READY' });
  } else {
    qb.where({ album_id: q.albumId ?? '' });
    if (!q.viewerIsOwner) qb.where({ visibility: 'public', status: 'READY' });
  }
  applyCursor(qb, q.cursor);
  const rows = (await qb.orderBy([{ column: 'created_at', order: 'desc' }, { column: 'id', order: 'desc' }]).limit(limit + 1)) as Row[];
  const items = rows.slice(0, limit).map(toPhoto);
  const last = items[items.length - 1];
  return { items, ...(rows.length > limit && last ? { next: encodeCursor(last) } : {}) };
}

/** GET /api/search?tag=color:blue：走 photo_labels.name 索引；查看者能看到自己的全部照片与他人公开且 READY 的照片 */
export async function searchByTag(db: Knex, q: { tag: string; viewerId?: string; isAdmin?: boolean; limit: number; cursor?: string }): Promise<{ items: Photo[]; next?: string }> {
  const limit = Math.max(1, Math.min(100, q.limit));
  const qb = db('photos').whereIn('id', db('photo_labels').select('photo_id').where('name', q.tag));
  if (!q.isAdmin) {
    qb.where((w) => {
      w.where({ visibility: 'public', status: 'READY' });
      if (q.viewerId) w.orWhere({ owner_id: q.viewerId });
    });
  }
  applyCursor(qb, q.cursor);
  const rows = (await qb.orderBy([{ column: 'created_at', order: 'desc' }, { column: 'id', order: 'desc' }]).limit(limit + 1)) as Row[];
  const items = rows.slice(0, limit).map(toPhoto);
  const last = items[items.length - 1];
  return { items, ...(rows.length > limit && last ? { next: encodeCursor(last) } : {}) };
}

/** 热门标签（搜索页的建议） */
export async function topLabels(db: Knex, limit = 20): Promise<Array<{ name: string; count: number }>> {
  const rows = (await db('photo_labels').select('name').count({ count: '*' }).groupBy('name').orderBy('count', 'desc').limit(limit)) as Row[];
  return rows.map((r) => ({ name: String(r.name), count: Number(r.count) }));
}

// ---------------------------------------------------------------------------------------------
// 相册与用户（只读辅助；相册 CRUD 归 albums 路由）
// ---------------------------------------------------------------------------------------------
export interface AlbumRef { id: string; ownerId: string; visibility: Visibility; isDefault: boolean; title: string }

export async function getAlbumRef(db: Knex, albumId: string): Promise<AlbumRef | undefined> {
  const r = (await db('albums').select('id', 'owner_id', 'visibility', 'is_default', 'title').where({ id: albumId }).first()) as Row | undefined;
  return r ? { id: String(r.id), ownerId: String(r.owner_id), visibility: r.visibility as Visibility, isDefault: boolIn(r.is_default), title: String(r.title) } : undefined;
}

export async function defaultAlbumId(db: Knex, userId: string): Promise<string | null> {
  const r = (await db('albums').select('id').where({ owner_id: userId }).orderBy([{ column: 'is_default', order: 'desc' }, { column: 'created_at', order: 'asc' }]).first()) as Row | undefined;
  return r ? String(r.id) : null;
}

export async function userNames(db: Knex, ids: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const list = [...new Set(ids)].filter(Boolean);
  for (let i = 0; i < list.length; i += 200) {
    const rows = (await db('users').select('id', 'display_name', 'email').whereIn('id', list.slice(i, i + 200))) as Row[];
    for (const r of rows) out.set(String(r.id), String(r.display_name || String(r.email).split('@')[0]));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// 统计（日报 F13）
// ---------------------------------------------------------------------------------------------
export async function photoStatsBetween(db: Knex, from: string, to: string): Promise<{ uploads: number; ready: number; failed: number; uploaders: string[] }> {
  const base = () => db('photos').where('created_at', '>=', from).andWhere('created_at', '<', to);
  const uploads = countOf(await base().count({ count: '*' }).first());
  const ready = countOf(await base().whereIn('status', ['READY', 'BLOCKED']).count({ count: '*' }).first());
  const failed = countOf(await base().where({ status: 'FAILED' }).count({ count: '*' }).first());
  const uploaders = ((await base().distinct('owner_id')) as Row[]).map((r) => String(r.owner_id));
  return { uploads, ready, failed, uploaders };
}

/** 照片总数（磁盘与 /lab 卡片） */
export async function countPhotos(db: Knex): Promise<number> {
  return countOf(await db('photos').count({ count: '*' }).first());
}
