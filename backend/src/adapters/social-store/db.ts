// backend/src/adapters/social-store/db.ts —— SocialStorePort 的 `db` 驱动（本地实现，L0 默认）
// likes / comments / photo_counters / share_links 表（SQL 在 repositories/social-db.ts），经 Knex 使用当前数据库（sqlite 或 postgres）。
// 权威端口：数据库故障时社交写接口返回错误，不回退。upsertPhotoSummary 在 db 驱动下是空操作（/social 直接读 photos 表）。
import type { AdapterDeps } from '../types.js';
import { need } from '../types.js';
import type { AdapterMeta, Page, ProbeResult } from '../../ports/common.js';
import type { Comment, ShareLink, SocialItem, SocialStorePort } from '../../ports/social-store.js';
import { HttpError } from '../../errors.js';
import { nowIso } from '../../db/dialect.js';
import * as repo from '../../repositories/social-db.js';

/** 分享链接的默认有效期与上限（03#social-store 第 3 节：业务常量） */
export const SHARE_DEFAULT_TTL_SEC = 24 * 3600;
export const SHARE_MAX_TTL_SEC = 30 * 24 * 3600;
export const SHARE_MIN_TTL_SEC = 60;

export function clampShareTtl(ttlSec: number | undefined): number {
  const v = Number.isFinite(ttlSec) ? Math.floor(ttlSec as number) : SHARE_DEFAULT_TTL_SEC;
  return Math.min(SHARE_MAX_TTL_SEC, Math.max(SHARE_MIN_TTL_SEC, v));
}

export class DbSocialStore implements SocialStorePort {
  readonly meta: AdapterMeta = { module: 'social-store', driver: 'db', awsService: null, authoritative: true };

  constructor(protected readonly deps: AdapterDeps) {}

  private get db() {
    return need(this.deps, 'db', 'social-store(db)');
  }

  async probe(_opts?: { deep?: boolean }): Promise<ProbeResult> {
    try {
      await repo.socialTablesReadable(this.db);
      const expired = await repo.countExpiredShares(this.db);
      return {
        status: 'ok',
        detail: `点赞、评论与分享链接存于当前关系库（${this.deps.cfg.db.DB_DRIVER}）${expired ? ` · 已过期待清理的分享链接 ${expired}` : ''}`,
        data: { expiredShares: expired },
      };
    } catch (e) {
      return { status: 'error', detail: `社交表不可读：${(e as Error).message}` };
    }
  }

  like(photoId: string, userId: string): Promise<{ created: boolean; likes: number }> {
    return repo.like(this.db, photoId, userId);
  }

  unlike(photoId: string, userId: string): Promise<{ removed: boolean; likes: number }> {
    return repo.unlike(this.db, photoId, userId);
  }

  addComment(photoId: string, userId: string, text: string): Promise<Comment> {
    return repo.addComment(this.db, { photoId, userId, text });
  }

  async deleteComment(photoId: string, commentId: string, byUserId: string): Promise<void> {
    const r = await repo.deleteComment(this.db, photoId, commentId, byUserId);
    if (r === 'not-found') throw new HttpError(404, 'COMMENT_NOT_FOUND', '评论不存在');
    if (r === 'forbidden') throw new HttpError(403, 'FORBIDDEN', '只能删除自己的评论');
  }

  listComments(photoId: string, opts: { limit: number; cursor?: string }): Promise<Page<Comment>> {
    return repo.listComments(this.db, photoId, opts);
  }

  listCommentsByUser(userId: string, opts: { limit: number; cursor?: string }): Promise<Page<Comment>> {
    return repo.listCommentsByUser(this.db, userId, opts);
  }

  getCounters(photoIds: string[]): Promise<Record<string, { likes: number; comments: number }>> {
    return repo.getCounters(this.db, photoIds);
  }

  likedBy(photoIds: string[], userId: string): Promise<Set<string>> {
    return repo.likedBy(this.db, photoIds, userId);
  }

  createShare(input: { photoId: string; createdBy: string; ttlSec: number }): Promise<ShareLink> {
    const ttl = clampShareTtl(input.ttlSec);
    return repo.createShare(this.db, {
      photoId: input.photoId, createdBy: input.createdBy, expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
    });
  }

  /** 自行比较 expiresAt：过期或不存在返回 null */
  resolveShare(token: string): Promise<ShareLink | null> {
    if (!token || token.length > 64) return Promise.resolve(null);
    return repo.resolveShare(this.db, token, nowIso());
  }

  purgeExpiredShares(): Promise<number> {
    return repo.purgeExpiredShares(this.db);
  }

  purgePhoto(photoId: string): Promise<void> {
    return repo.purgePhoto(this.db, photoId);
  }

  async upsertPhotoSummary(_photo: { photoId: string; ownerId: string; visibility: 'public' | 'private'; status: string }): Promise<void> {
    /* db 驱动：空操作 */
  }

  count(): Promise<number> {
    return repo.countItems(this.db);
  }

  exportBatch(cursor?: string, limit = 500): Promise<{ items: SocialItem[]; next?: string }> {
    return repo.exportItems(this.db, cursor, limit);
  }

  importBatch(items: SocialItem[]): Promise<{ written: number; skipped: number }> {
    return repo.importItems(this.db, items);
  }
}
