// backend/src/adapters/social-store/dynamodb.ts —— SocialStorePort 的 `dynamodb` 驱动（Amazon DynamoDB）
// 本轮未实现
// 脚手架桩：方法抛出 NotImplementedError（HTTP 层映射为 501）。由「后续版本（本轮 MVP 不实现；配置该驱动会被 config/implemented.ts 以 CFG-001 拒绝）」填充。
import type { AdapterDeps } from '../types.js';
import type { AdapterMeta, Page, ProbeResult } from '../../ports/common.js';
import type { Comment, ShareLink, SocialItem, SocialStorePort } from '../../ports/social-store.js';
import { notImplemented } from '../../errors.js';

export class DynamoSocialStore implements SocialStorePort {
  readonly meta: AdapterMeta = { module: 'social-store', driver: 'dynamodb', awsService: 'Amazon DynamoDB', authoritative: true };

  constructor(protected readonly deps: AdapterDeps) {}

  async probe(_opts?: { deep?: boolean }): Promise<ProbeResult> {
    throw notImplemented('DynamoSocialStore', 'probe', 'social-store');
  }

  async like(_photoId: string, _userId: string): Promise<{ created: boolean; likes: number }> {
    throw notImplemented('DynamoSocialStore', 'like', 'social-store');
  }

  async unlike(_photoId: string, _userId: string): Promise<{ removed: boolean; likes: number }> {
    throw notImplemented('DynamoSocialStore', 'unlike', 'social-store');
  }

  async addComment(_photoId: string, _userId: string, _text: string): Promise<Comment> {
    throw notImplemented('DynamoSocialStore', 'addComment', 'social-store');
  }

  async deleteComment(_photoId: string, _commentId: string, _byUserId: string): Promise<void> {
    throw notImplemented('DynamoSocialStore', 'deleteComment', 'social-store');
  }

  async listComments(_photoId: string, _opts: { limit: number; cursor?: string }): Promise<Page<Comment>> {
    throw notImplemented('DynamoSocialStore', 'listComments', 'social-store');
  }

  async listCommentsByUser(_userId: string, _opts: { limit: number; cursor?: string }): Promise<Page<Comment>> {
    throw notImplemented('DynamoSocialStore', 'listCommentsByUser', 'social-store');
  }

  async getCounters(_photoIds: string[]): Promise<Record<string, { likes: number; comments: number }>> {
    throw notImplemented('DynamoSocialStore', 'getCounters', 'social-store');
  }

  async likedBy(_photoIds: string[], _userId: string): Promise<Set<string>> {
    throw notImplemented('DynamoSocialStore', 'likedBy', 'social-store');
  }

  async createShare(_input: { photoId: string; createdBy: string; ttlSec: number }): Promise<ShareLink> {
    throw notImplemented('DynamoSocialStore', 'createShare', 'social-store');
  }

  async resolveShare(_token: string): Promise<ShareLink | null> {
    throw notImplemented('DynamoSocialStore', 'resolveShare', 'social-store');
  }

  async purgeExpiredShares(): Promise<number> {
    throw notImplemented('DynamoSocialStore', 'purgeExpiredShares', 'social-store');
  }

  async purgePhoto(_photoId: string): Promise<void> {
    throw notImplemented('DynamoSocialStore', 'purgePhoto', 'social-store');
  }

  async upsertPhotoSummary(_photo: { photoId: string; ownerId: string; visibility: 'public' | 'private'; status: string }): Promise<void> {
    throw notImplemented('DynamoSocialStore', 'upsertPhotoSummary', 'social-store');
  }

  async count(): Promise<number> {
    throw notImplemented('DynamoSocialStore', 'count', 'social-store');
  }

  async exportBatch(_cursor?: string, _limit?: number): Promise<{ items: SocialItem[]; next?: string }> {
    throw notImplemented('DynamoSocialStore', 'exportBatch', 'social-store');
  }

  async importBatch(_items: SocialItem[]): Promise<{ written: number; skipped: number }> {
    throw notImplemented('DynamoSocialStore', 'importBatch', 'social-store');
  }
}
