// 点赞、评论（F9）与分享链接（F11）。
// 点赞 / 评论的基址取 capabilities 中 social-api.public.baseUrl（总纲 12.2）：为空 → 同源相对路径 /social（Express，Cookie 会话）；
// 非空 → API Gateway 地址，跨域请求带 GET /api/auth/session?for=social 取得的内存短期令牌（Authorization: Bearer），不带 Cookie。
// 分享链接走同源的 /api/shares（后端 routes/social.ts）。
// 路径与后端 backend/src/http/routes/social.ts 一致；响应解析同时兼容两种写法（{counters:{…}} 或扁平计数、{comment} 或评论本身、next 或 nextCursor）。
import type { CapabilitiesResponse } from '@cloudalbum/contracts';
import { api, type ApiOptions } from './client';
import { authApi, normPhoto } from './endpoints';
import type { Comment, Page, PhotoCounters, ShareLink, SharedPhoto } from './types';

const enc = encodeURIComponent;

export function socialBaseUrl(caps: CapabilitiesResponse | null | undefined): string {
  const raw = caps?.modules['social-api']?.public?.['baseUrl'];
  return typeof raw === 'string' ? raw.trim().replace(/\/+$/, '') : '';
}

function isCrossOrigin(baseUrl: string): boolean {
  if (!baseUrl) return false;
  try {
    return new URL(baseUrl, globalThis.location?.href).origin !== globalThis.location?.origin;
  } catch {
    return false;
  }
}

let cachedToken: { token: string; exp: number } | null = null;

async function socialToken(): Promise<string> {
  if (cachedToken && cachedToken.exp - Date.now() > 30_000) return cachedToken.token;
  const t = await authApi.socialSession();
  cachedToken = { token: t.token, exp: Date.parse(t.expiresAt) || Date.now() + 5 * 60_000 };
  return t.token;
}

/** 测试用 */
export function clearSocialToken(): void {
  cachedToken = null;
}

interface RawCounters {
  counters?: { likes?: number; comments?: number };
  likes?: number;
  comments?: number;
  likedByMe?: boolean;
}

/** {photoId, counters:{likes,comments}, likedByMe} 或 {likes, comments, likedByMe}；缺的项沿用 prev */
export function normCounters(r: RawCounters, prev?: PhotoCounters | null): PhotoCounters {
  return {
    likes: r.counters?.likes ?? r.likes ?? prev?.likes ?? 0,
    comments: r.counters?.comments ?? r.comments ?? prev?.comments ?? 0,
    likedByMe: r.likedByMe ?? prev?.likedByMe ?? false,
  };
}

export function normComment(c: Comment): Comment {
  const name = c.userName ?? c.user?.displayName;
  return { ...c, ...(name ? { userName: name } : {}) };
}

export interface SocialApi {
  baseUrl: string;
  crossOrigin: boolean;
  counters(photoId: string): Promise<PhotoCounters>;
  like(photoId: string, prev?: PhotoCounters | null): Promise<PhotoCounters>;
  unlike(photoId: string, prev?: PhotoCounters | null): Promise<PhotoCounters>;
  comments(photoId: string, cursor?: string | null): Promise<Page<Comment>>;
  addComment(photoId: string, text: string, opts?: Pick<ApiOptions, 'bypass'>): Promise<Comment>;
  deleteComment(photoId: string, commentId: string): Promise<void>;
  createShare(photoId: string, ttlSec: number): Promise<ShareLink>;
  getShare(token: string): Promise<SharedPhoto>;
}

export function createSocialApi(baseUrl: string): SocialApi {
  const crossOrigin = isCrossOrigin(baseUrl);
  const call = async <T>(path: string, opts: ApiOptions = {}): Promise<T> => {
    if (!crossOrigin) return api<T>(path, opts);
    const headers = { ...(opts.headers ?? {}) };
    // 只读接口对匿名访客开放：取令牌失败时不带 Authorization 继续
    try {
      headers.Authorization = `Bearer ${await socialToken()}`;
    } catch {
      /* 匿名 */
    }
    return api<T>(path, { ...opts, baseUrl, headers, credentials: 'omit' });
  };
  return {
    baseUrl,
    crossOrigin,
    counters: async (id) => normCounters(await call<RawCounters>(`/social/photos/${enc(id)}`)),
    like: async (id, prev) => normCounters(await call<RawCounters>(`/social/photos/${enc(id)}/likes`, { method: 'POST' }), prev),
    unlike: async (id, prev) => normCounters(await call<RawCounters>(`/social/photos/${enc(id)}/likes`, { method: 'DELETE' }), prev),
    comments: async (id, cursor) => {
      const p = await call<Page<Comment>>(`/social/photos/${enc(id)}/comments`, { query: { cursor: cursor ?? undefined } });
      return { items: (p.items ?? []).map(normComment), nextCursor: p.nextCursor ?? p.next ?? null };
    },
    addComment: async (id, text, opts = {}) => {
      const r = await call<{ comment?: Comment } & Partial<Comment>>(`/social/photos/${enc(id)}/comments`, { json: { text }, ...opts });
      return normComment((r.comment ?? r) as Comment);
    },
    deleteComment: (photoId, commentId) => call<void>(`/social/photos/${enc(photoId)}/comments/${enc(commentId)}`, { method: 'DELETE' }),
    createShare: async (photoId, ttlSec) => {
      const s = await api<ShareLink>('/api/shares', { json: { photoId, ttlSec } });
      return { ...s, url: s.url || `${globalThis.location?.origin ?? ''}/s/${s.token}` };
    },
    getShare: async (token) => {
      const r = await api<SharedPhoto>(`/api/shares/${enc(token)}`);
      return { ...r, photo: normPhoto(r.photo), expiresAt: r.expiresAt ?? r.share?.expiresAt ?? '' };
    },
  };
}
