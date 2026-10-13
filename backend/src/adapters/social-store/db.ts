// backend/src/adapters/social-store/db.ts —— SocialStorePort 的 `db` 驱动（本地实现）
// likes / comments / photo_counters / share_links 表（repositories/social-db.ts）
// 脚手架桩：方法抛出 NotImplementedError（HTTP 层映射为 501）。由「L0 本地实现者」填充。
import type { AdapterDeps } from '../types.js';
import type { AdapterMeta, Page, ProbeResult } from '../../ports/common.js';
import type { Comment, ShareLink, SocialItem, SocialStorePort } from '../../ports/social-store.js';
import { notImplemented } from '../../errors.js';

export class DbSocialStore implements SocialStorePort {
  readonly meta: AdapterMeta = { module: 'social-store', driver: 'db', awsService: null, authoritative: true };

  constructor(protected readonly deps: AdapterDeps) {}

  async probe(_opts?: { deep?: boolean }): Promise<ProbeResult> {
    throw notImplemented('DbSocialStore', 'probe', 'social-store');
  }

  async like(_photoId: string, _userId: string): Promise<{ created: boolean; likes: number }> {
    throw notImplemented('DbSocialStore', 'like', 'social-store');
  }

  async unlike(_photoId: string, _userId: string): Promise<{ removed: boolean; likes: number }> {
    throw notImplemented('DbSocialStore', 'unlike', 'social-store');
  }

  async addComment(_photoId: string, _userId: string, _text: string): Promise<Comment> {
    throw notImplemented('DbSocialStore', 'addComment', 'social-store');
  }

  async deleteComment(_photoId: string, _commentId: string, _byUserId: string): Promise<void> {
    throw notImplemented('DbSocialStore', 'deleteComment', 'social-store');
  }

  async listComments(_photoId: string, _opts: { limit: number; cursor?: string }): Promise<Page<Comment>> {
    throw notImplemented('DbSocialStore', 'listComments', 'social-store');
  }

  async listCommentsByUser(_userId: string, _opts: { limit: number; cursor?: string }): Promise<Page<Comment>> {
    throw notImplemented('DbSocialStore', 'listCommentsByUser', 'social-store');
  }

  async getCounters(_photoIds: string[]): Promise<Record<string, { likes: number; comments: number }>> {
    throw notImplemented('DbSocialStore', 'getCounters', 'social-store');
  }

  async likedBy(_photoIds: string[], _userId: string): Promise<Set<string>> {
    throw notImplemented('DbSocialStore', 'likedBy', 'social-store');
  }

  async createShare(_input: { photoId: string; createdBy: string; ttlSec: number }): Promise<ShareLink> {
    throw notImplemented('DbSocialStore', 'createShare', 'social-store');
  }

  async resolveShare(_token: string): Promise<ShareLink | null> {
    throw notImplemented('DbSocialStore', 'resolveShare', 'social-store');
  }

  async purgeExpiredShares(): Promise<number> {
    throw notImplemented('DbSocialStore', 'purgeExpiredShares', 'social-store');
  }

  async purgePhoto(_photoId: string): Promise<void> {
    throw notImplemented('DbSocialStore', 'purgePhoto', 'social-store');
  }

  async upsertPhotoSummary(_photo: { photoId: string; ownerId: string; visibility: 'public' | 'private'; status: string }): Promise<void> {
    throw notImplemented('DbSocialStore', 'upsertPhotoSummary', 'social-store');
  }

  async count(): Promise<number> {
    throw notImplemented('DbSocialStore', 'count', 'social-store');
  }

  async exportBatch(_cursor?: string, _limit?: number): Promise<{ items: SocialItem[]; next?: string }> {
    throw notImplemented('DbSocialStore', 'exportBatch', 'social-store');
  }

  async importBatch(_items: SocialItem[]): Promise<{ written: number; skipped: number }> {
    throw notImplemented('DbSocialStore', 'importBatch', 'social-store');
  }
}
