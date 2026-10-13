// backend/src/repositories/social-db.ts —— SocialStorePort(db) 的 SQL：likes、comments、photo_counters、share_links（03#social-store 第 1 节）
//
// - 点赞：同一事务内“先查后插”，确实插入了新行才对 photo_counters 做 +1（ON CONFLICT (photo_id) DO UPDATE）；
//   并发重复点赞撞上主键时整笔重试一次（不用 insertIgnore 的返回值判断：better-sqlite3 在 DO NOTHING 时也返回 lastInsertRowid）。
// - 评论 ID 是 ULID（与 DynamoDB 的 SK = C#<ulid> 一致）；列表倒序，游标 = 上一页最后一条的 ULID。
// - 分享链接：读取时比较 expires_at（过期返回 null）；物理删除由 share.cleanup 分批执行。
import { randomBytes } from 'node:crypto';
import type { Knex } from 'knex';
import { monotonicFactory } from 'ulid';
import { countOf, isUniqueViolation, nowIso } from '../db/dialect.js';
import type { Comment, ShareLink, SocialItem } from '../ports/social-store.js';
import type { Page } from '../ports/common.js';

type Row = Record<string, unknown>;
const nextUlid = monotonicFactory();

export function newCommentId(): string {
  return nextUlid();
}

export function newShareToken(): string {
  return randomBytes(24).toString('base64url');   // 32 字符，不可猜测
}

const toComment = (r: Row): Comment => ({
  id: String(r.id), photoId: String(r.photo_id), userId: String(r.user_id), text: String(r.text), createdAt: String(r.created_at),
});
const toShare = (r: Row): ShareLink => ({
  token: String(r.token), photoId: String(r.photo_id), createdBy: String(r.created_by),
  createdAt: String(r.created_at), expiresAt: String(r.expires_at),
});

async function withUniqueRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    return fn();
  }
}

async function bumpCounter(trx: Knex.Transaction | Knex, photoId: string, column: 'likes' | 'comments', delta: 1 | -1): Promise<void> {
  const now = nowIso();
  if (delta > 0) {
    await trx('photo_counters')
      .insert({ photo_id: photoId, likes: column === 'likes' ? 1 : 0, comments: column === 'comments' ? 1 : 0, updated_at: now })
      .onConflict('photo_id')
      .merge({ [column]: trx.raw(`photo_counters.${column} + 1`), updated_at: now });
  } else {
    await trx('photo_counters').where({ photo_id: photoId })
      .update({ [column]: trx.raw(`CASE WHEN ${column} > 0 THEN ${column} - 1 ELSE 0 END`), updated_at: now });
  }
}

async function counterOf(trx: Knex.Transaction | Knex, photoId: string): Promise<{ likes: number; comments: number }> {
  const r = (await trx('photo_counters').where({ photo_id: photoId }).first()) as Row | undefined;
  return { likes: Number(r?.likes ?? 0), comments: Number(r?.comments ?? 0) };
}

// ---------------------------------------------------------------------------------------------
// 点赞
// ---------------------------------------------------------------------------------------------
export async function like(db: Knex, photoId: string, userId: string): Promise<{ created: boolean; likes: number }> {
  return withUniqueRetry(() => db.transaction(async (trx) => {
    const exists = await trx('likes').where({ photo_id: photoId, user_id: userId }).first();
    let created = false;
    if (!exists) {
      await trx('likes').insert({ photo_id: photoId, user_id: userId, created_at: nowIso() });
      await bumpCounter(trx, photoId, 'likes', 1);
      created = true;
    }
    return { created, likes: (await counterOf(trx, photoId)).likes };
  }));
}

export async function unlike(db: Knex, photoId: string, userId: string): Promise<{ removed: boolean; likes: number }> {
  return db.transaction(async (trx) => {
    const n = await trx('likes').where({ photo_id: photoId, user_id: userId }).del();
    if (n > 0) await bumpCounter(trx, photoId, 'likes', -1);
    return { removed: n > 0, likes: (await counterOf(trx, photoId)).likes };
  });
}

export async function likedBy(db: Knex, photoIds: readonly string[], userId: string): Promise<Set<string>> {
  if (!photoIds.length) return new Set();
  const rows = (await db('likes').select('photo_id').where({ user_id: userId }).whereIn('photo_id', [...new Set(photoIds)])) as Row[];
  return new Set(rows.map((r) => String(r.photo_id)));
}

export async function getCounters(db: Knex, photoIds: readonly string[]): Promise<Record<string, { likes: number; comments: number }>> {
  const out: Record<string, { likes: number; comments: number }> = {};
  const ids = [...new Set(photoIds)];
  for (const id of ids) out[id] = { likes: 0, comments: 0 };
  for (let i = 0; i < ids.length; i += 200) {
    const rows = (await db('photo_counters').whereIn('photo_id', ids.slice(i, i + 200))) as Row[];
    for (const r of rows) out[String(r.photo_id)] = { likes: Number(r.likes ?? 0), comments: Number(r.comments ?? 0) };
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// 评论
// ---------------------------------------------------------------------------------------------
export async function addComment(db: Knex, c: { id?: string; photoId: string; userId: string; text: string; createdAt?: string }): Promise<Comment> {
  const row = { id: c.id ?? newCommentId(), photo_id: c.photoId, user_id: c.userId, text: c.text, created_at: c.createdAt ?? nowIso() };
  await db.transaction(async (trx) => {
    await trx('comments').insert(row);
    await bumpCounter(trx, c.photoId, 'comments', 1);
  });
  return toComment(row);
}

export async function getComment(db: Knex, photoId: string, commentId: string): Promise<Comment | undefined> {
  const r = (await db('comments').where({ id: commentId, photo_id: photoId }).first()) as Row | undefined;
  return r ? toComment(r) : undefined;
}

/** 删除评论；返回 'deleted' | 'not-found' | 'forbidden'（只有作者本人能删） */
export async function deleteComment(db: Knex, photoId: string, commentId: string, byUserId: string): Promise<'deleted' | 'not-found' | 'forbidden'> {
  return db.transaction(async (trx) => {
    const r = (await trx('comments').where({ id: commentId, photo_id: photoId }).first()) as Row | undefined;
    if (!r) return 'not-found';
    if (String(r.user_id) !== byUserId) return 'forbidden';
    await trx('comments').where({ id: commentId }).del();
    await bumpCounter(trx, photoId, 'comments', -1);
    return 'deleted';
  });
}

export async function listComments(db: Knex, photoId: string, opts: { limit: number; cursor?: string }): Promise<Page<Comment>> {
  const limit = Math.max(1, Math.min(100, opts.limit));
  const q = db('comments').where({ photo_id: photoId });
  if (opts.cursor) q.andWhere('id', '<', opts.cursor);
  const rows = (await q.orderBy('id', 'desc').limit(limit + 1)) as Row[];
  const items = rows.slice(0, limit).map(toComment);
  return { items, ...(rows.length > limit ? { next: items[items.length - 1]!.id } : {}) };
}

export async function listCommentsByUser(db: Knex, userId: string, opts: { limit: number; cursor?: string }): Promise<Page<Comment>> {
  const limit = Math.max(1, Math.min(100, opts.limit));
  const q = db('comments').where({ user_id: userId });
  if (opts.cursor) q.andWhere('id', '<', opts.cursor);
  const rows = (await q.orderBy('id', 'desc').limit(limit + 1)) as Row[];
  const items = rows.slice(0, limit).map(toComment);
  return { items, ...(rows.length > limit ? { next: items[items.length - 1]!.id } : {}) };
}

// ---------------------------------------------------------------------------------------------
// 分享链接（F11）
// ---------------------------------------------------------------------------------------------
export async function createShare(db: Knex, s: { token?: string; photoId: string; createdBy: string; createdAt?: string; expiresAt: string }): Promise<ShareLink> {
  const row = { token: s.token ?? newShareToken(), photo_id: s.photoId, created_by: s.createdBy, created_at: s.createdAt ?? nowIso(), expires_at: s.expiresAt };
  await db('share_links').insert(row);
  return toShare(row);
}

/** 读取分享链接；过期（expires_at ≤ now）或不存在返回 null */
export async function resolveShare(db: Knex, token: string, now: string = nowIso()): Promise<ShareLink | null> {
  const r = (await db('share_links').where({ token }).first()) as Row | undefined;
  if (!r || String(r.expires_at) <= now) return null;
  return toShare(r);
}

export async function sharesOfPhoto(db: Knex, photoId: string): Promise<ShareLink[]> {
  const rows = (await db('share_links').where({ photo_id: photoId }).orderBy('created_at', 'desc')) as Row[];
  return rows.map(toShare);
}

export async function revokeShare(db: Knex, token: string, byUserId: string): Promise<boolean> {
  return (await db('share_links').where({ token, created_by: byUserId }).del()) > 0;
}

/** 分批删除过期链接（每批一个短事务，避免长时间持有 SQLite 写锁） */
export async function purgeExpiredShares(db: Knex, now: string = nowIso(), batch = 500): Promise<number> {
  let total = 0;
  for (;;) {
    const tokens = ((await db('share_links').select('token').where('expires_at', '<=', now).limit(batch)) as Row[]).map((r) => String(r.token));
    if (!tokens.length) break;
    total += await db('share_links').whereIn('token', tokens).del();
    if (tokens.length < batch) break;
  }
  return total;
}

export async function countExpiredShares(db: Knex, now: string = nowIso()): Promise<number> {
  return countOf(await db('share_links').where('expires_at', '<=', now).count({ count: '*' }).first());
}

/** 照片删除后清理全部社交数据（同一事务） */
export async function purgePhoto(db: Knex, photoId: string): Promise<void> {
  await db.transaction(async (trx) => {
    await trx('likes').where({ photo_id: photoId }).del();
    await trx('comments').where({ photo_id: photoId }).del();
    await trx('photo_counters').where({ photo_id: photoId }).del();
    await trx('share_links').where({ photo_id: photoId }).del();
  });
}

// ---------------------------------------------------------------------------------------------
// 迁移（Migratable<SocialItem>）：游标 = "<阶段>:<键>"，阶段依次为 like、comment、share
// ---------------------------------------------------------------------------------------------
export async function countItems(db: Knex): Promise<number> {
  const [a, b, c] = await Promise.all([
    db('likes').count({ count: '*' }).first(), db('comments').count({ count: '*' }).first(), db('share_links').count({ count: '*' }).first(),
  ]);
  return countOf(a) + countOf(b) + countOf(c);
}

const PHASES = ['like', 'comment', 'share'] as const;

export async function exportItems(db: Knex, cursor: string | undefined, limit: number): Promise<{ items: SocialItem[]; next?: string }> {
  const size = Math.max(1, Math.min(1000, limit));
  let phaseIdx = 0;
  let after = '';
  if (cursor) {
    const i = cursor.indexOf(':');
    phaseIdx = Math.max(0, PHASES.indexOf(cursor.slice(0, i) as (typeof PHASES)[number]));
    after = cursor.slice(i + 1);
  }
  for (; phaseIdx < PHASES.length; phaseIdx++, after = '') {
    const phase = PHASES[phaseIdx]!;
    if (phase === 'like') {
      const q = db('likes').select('*', db.raw("photo_id || '|' || user_id as k"));
      if (after) q.whereRaw("photo_id || '|' || user_id > ?", [after]);
      const rows = (await q.orderByRaw("photo_id || '|' || user_id").limit(size)) as Row[];
      if (!rows.length) continue;
      const items: SocialItem[] = rows.map((r) => ({ kind: 'like', photoId: String(r.photo_id), userId: String(r.user_id), createdAt: String(r.created_at) }));
      return { items, next: `like:${String(rows[rows.length - 1]!.k)}` };
    }
    if (phase === 'comment') {
      const q = db('comments');
      if (after) q.where('id', '>', after);
      const rows = (await q.orderBy('id', 'asc').limit(size)) as Row[];
      if (!rows.length) continue;
      return { items: rows.map((r) => ({ kind: 'comment', comment: toComment(r) })), next: `comment:${String(rows[rows.length - 1]!.id)}` };
    }
    const q = db('share_links');
    if (after) q.where('token', '>', after);
    const rows = (await q.orderBy('token', 'asc').limit(size)) as Row[];
    if (!rows.length) continue;
    return { items: rows.map((r) => ({ kind: 'share', share: toShare(r) })), next: `share:${String(rows[rows.length - 1]!.token)}` };
  }
  return { items: [] };
}

/** 幂等导入：已存在的项跳过；计数器按导入的点赞 / 评论增量维护 */
export async function importItems(db: Knex, items: readonly SocialItem[]): Promise<{ written: number; skipped: number }> {
  let written = 0;
  let skipped = 0;
  for (const it of items) {
    if (it.kind === 'like') {
      const r = await withUniqueRetry(() => db.transaction(async (trx) => {
        if (await trx('likes').where({ photo_id: it.photoId, user_id: it.userId }).first()) return false;
        await trx('likes').insert({ photo_id: it.photoId, user_id: it.userId, created_at: it.createdAt });
        await bumpCounter(trx, it.photoId, 'likes', 1);
        return true;
      }));
      if (r) written++; else skipped++;
    } else if (it.kind === 'comment') {
      if (await db('comments').where({ id: it.comment.id }).first()) { skipped++; continue; }
      await addComment(db, it.comment);
      written++;
    } else {
      if (await db('share_links').where({ token: it.share.token }).first()) { skipped++; continue; }
      await createShare(db, it.share);
      written++;
    }
  }
  return { written, skipped };
}

// ---------------------------------------------------------------------------------------------
// 统计（F13）
// ---------------------------------------------------------------------------------------------
export async function socialStatsBetween(db: Knex, from: string, to: string): Promise<{ likes: number; comments: number; actors: string[] }> {
  const likes = countOf(await db('likes').where('created_at', '>=', from).andWhere('created_at', '<', to).count({ count: '*' }).first());
  const comments = countOf(await db('comments').where('created_at', '>=', from).andWhere('created_at', '<', to).count({ count: '*' }).first());
  const a = (await db('likes').distinct('user_id').where('created_at', '>=', from).andWhere('created_at', '<', to)) as Row[];
  const b = (await db('comments').distinct('user_id').where('created_at', '>=', from).andWhere('created_at', '<', to)) as Row[];
  return { likes, comments, actors: [...new Set([...a, ...b].map((r) => String(r.user_id)))] };
}

/** 探针：表可读 */
export async function socialTablesReadable(db: Knex): Promise<void> {
  await db('photo_counters').select('photo_id').limit(1);
  await db('share_links').select('token').limit(1);
}
