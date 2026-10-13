// backend/src/ports/social-store.ts （总纲 §4.2，照录）
import type { Adapter, Migratable, Page } from './common.js';

export interface Comment { id: string; photoId: string; userId: string; text: string; createdAt: string }
export interface ShareLink { token: string; photoId: string; createdBy: string; createdAt: string; expiresAt: string }
export type SocialItem =
  | { kind: 'like'; photoId: string; userId: string; createdAt: string }
  | { kind: 'comment'; comment: Comment }
  | { kind: 'share'; share: ShareLink };

export interface SocialStorePort extends Adapter, Migratable<SocialItem> {
  like(photoId: string, userId: string): Promise<{ created: boolean; likes: number }>;     // 幂等：一人一赞
  unlike(photoId: string, userId: string): Promise<{ removed: boolean; likes: number }>;
  addComment(photoId: string, userId: string, text: string): Promise<Comment>;
  deleteComment(photoId: string, commentId: string, byUserId: string): Promise<void>;
  listComments(photoId: string, opts: { limit: number; cursor?: string }): Promise<Page<Comment>>;
  listCommentsByUser(userId: string, opts: { limit: number; cursor?: string }): Promise<Page<Comment>>;  // DynamoDB GSI1
  getCounters(photoIds: string[]): Promise<Record<string, { likes: number; comments: number }>>;
  likedBy(photoIds: string[], userId: string): Promise<Set<string>>;
  createShare(input: { photoId: string; createdBy: string; ttlSec: number }): Promise<ShareLink>;
  /** 必须自行比较 expiresAt：DynamoDB TTL 删除是后台异步的，过期项可能仍能读到（时延以官方文档为准） */
  resolveShare(token: string): Promise<ShareLink | null>;
  /** db：由 share.cleanup 定时调用；dynamodb：返回 0（交给 TTL） */
  purgeExpiredShares(): Promise<number>;
  /** 照片删除后清理全部社交数据 */
  purgePhoto(photoId: string): Promise<void>;
  /** dynamodb：EC2 维护照片摘要项 PHOTO#<id>/META，供 social-api 的 lambda 集成判断可见性与拦截状态；db：空操作 */
  upsertPhotoSummary(photo: { photoId: string; ownerId: string; visibility: 'public' | 'private'; status: string }): Promise<void>;
}
// 评论 ID 用 ULID（dynamodb 的 SK = C#<ulid>），删除时按 (photoId, commentId) 直接定位。
