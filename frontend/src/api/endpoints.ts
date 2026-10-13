// 同源 API 的类型化封装（社交接口见 social.ts，它按 social-api 的基址选址）。
import type { CapabilitiesResponse } from '@cloudalbum/contracts';
import { api, apiFetch, type ApiOptions } from './client';
import type {
  AdminUser, Album, AlbumDetail, AuditEntry, AuditVerifyResult, CompletePhotoRequest, CreatePhotoRequest,
  CreatePhotoResponse, DirectUploadSession, JobRun, JobsOverview, LabRequestRecord, LabResultRow, LoginResponse, Me,
  MyOutboxPage, NotificationItem, NotificationPrefs, OutboxEmailDetail, OutboxEmailSummary, Page, Photo,
  RegisterResponse, SocialSessionToken, TempAwsCredentials, Visibility,
} from './types';

const enc = encodeURIComponent;

/** 游标统一为 nextCursor（部分路由返回 next） */
export function normPage<T>(p: Page<T>, map?: (x: T) => T): Page<T> {
  const items = map ? (p.items ?? []).map(map) : (p.items ?? []);
  return { items, nextCursor: p.nextCursor ?? p.next ?? null };
}

/** 照片：owner.displayName → ownerName；urls 至少是空对象 */
export function normPhoto(p: Photo): Photo {
  return { ...p, ownerName: p.ownerName ?? p.owner?.displayName ?? '', urls: p.urls ?? {} };
}

export type FeedScope = 'mine' | 'public';

// ---------------------------------------------------------------- capabilities
export function getCapabilities(opts: { deep?: boolean } = {}): Promise<CapabilitiesResponse> {
  return api<CapabilitiesResponse>('/api/capabilities', { query: { deep: opts.deep ? 1 : undefined }, noRefresh: true });
}

// ---------------------------------------------------------------- 认证（BFF；cognito 的 sdk 子模式走同一组接口）
export const authApi = {
  me: () => api<Me>('/api/me', { noRefresh: false }),
  register: (input: { email: string; password: string; displayName: string }) =>
    api<RegisterResponse>('/api/auth/register', { json: input }),
  confirm: (input: { email: string; code: string }) => api<void>('/api/auth/confirm', { json: input }),
  resend: (email: string) => api<void>('/api/auth/resend', { json: { email } }),
  login: (input: { email: string; password: string }) => api<LoginResponse>('/api/auth/login', { json: input }),
  mfaVerify: (input: { challengeId?: string; code: string }) => api<LoginResponse>('/api/auth/mfa/verify', { json: input }),
  mfaEnroll: () => api<{ otpauthUrl: string; secret?: string }>('/api/auth/mfa/enroll', { method: 'POST' }),
  logout: () => api<void>('/api/auth/logout', { method: 'POST' }),
  forgot: (email: string) => api<void>('/api/auth/forgot', { json: { email } }),
  reset: (input: { email: string; code: string; newPassword: string }) => api<void>('/api/auth/reset', { json: input }),
  /** 跨域调用 social-api 时取得只存在内存中的短期令牌（cognito = ID token，local = 本地 access token） */
  socialSession: () => api<SocialSessionToken>('/api/auth/session', { query: { for: 'social' } }),
};

// ---------------------------------------------------------------- 相册与照片
export const albumsApi = {
  list: () => api<Page<Album>>('/api/albums').then((p) => normPage(p)),
  get: (id: string, opts: ApiOptions = {}) => api<AlbumDetail>(`/api/albums/${enc(id)}`, opts)
    .then((d) => ({ ...d, photos: (d.photos ?? []).map(normPhoto) })),
  create: (input: { title: string; description?: string; visibility: Visibility }) =>
    api<Album>('/api/albums', { json: input }),
  update: (id: string, patch: Partial<Pick<Album, 'title' | 'description' | 'visibility' | 'coverPhotoId'>>) =>
    api<Album>(`/api/albums/${enc(id)}`, { method: 'PATCH', json: patch }),
  remove: (id: string) => api<void>(`/api/albums/${enc(id)}`, { method: 'DELETE' }),
};

export const photosApi = {
  /** scope 省略时后端按登录状态选择（已登录 = mine，未登录 = public） */
  feed: (cursor?: string | null, opts: ApiOptions & { scope?: FeedScope } = {}) => {
    const { scope, ...rest } = opts;
    return api<Page<Photo>>('/api/feed', { ...rest, query: { ...(rest.query ?? {}), scope, cursor: cursor ?? undefined } })
      .then((p) => normPage(p, normPhoto));
  },
  get: (id: string, opts: ApiOptions = {}) => api<Photo>(`/api/photos/${enc(id)}`, opts).then(normPhoto),
  create: (input: CreatePhotoRequest) =>
    api<CreatePhotoResponse>('/api/photos', { json: { ...input, size: input.size ?? input.sizeBytes } }).then((r) => ({
      ...r,
      photo: normPhoto(r.photo),
      ...(r.upload ?? r.uploadTarget ? { upload: (r.upload ?? r.uploadTarget)! } : {}),
    })),
  complete: (id: string, input: CompletePhotoRequest = {}) =>
    api<{ photo: Photo } | Photo>(`/api/photos/${enc(id)}/complete`, { json: input }).then(unwrapPhoto),
  update: (id: string, patch: Partial<Pick<Photo, 'title' | 'caption' | 'albumId' | 'visibility'>>) =>
    api<Photo>(`/api/photos/${enc(id)}`, { method: 'PATCH', json: patch }).then(normPhoto),
  remove: (id: string) => api<void>(`/api/photos/${enc(id)}`, { method: 'DELETE' }),
  search: (tag: string) => api<Page<Photo>>('/api/search', { query: { tag } }).then((p) => normPage(p, normPhoto)),
};

/** complete 可能返回 {photo} 或照片本身（200 READY / 202 PROCESSING） */
export function unwrapPhoto(r: { photo: Photo } | Photo): Photo {
  return normPhoto('photo' in r && r.photo && typeof r.photo === 'object' ? r.photo : (r as Photo));
}

// ---------------------------------------------------------------- F14 直传
export const uploadsApi = {
  openSession: (opts: ApiOptions = {}) => api<DirectUploadSession>('/api/uploads/session', { ...opts, method: 'POST' }),
  credentials: () => api<TempAwsCredentials>('/api/uploads/credentials'),
};

// ---------------------------------------------------------------- 通知与本人 outbox
export const notificationsApi = {
  list: (cursor?: string | null) =>
    api<Page<NotificationItem>>('/api/notifications', { query: { cursor: cursor ?? undefined } }).then((p) => normPage(p)),
  unreadCount: () => api<{ count: number }>('/api/notifications/unread-count', { noTrace: false }),
  markRead: (id: string) => api<void>(`/api/notifications/${enc(id)}/read`, { method: 'POST' }),
  markAllRead: () => api<void>('/api/notifications/read-all', { method: 'POST' }),
  prefs: () => api<NotificationPrefs>('/api/notifications/prefs'),
  setPrefs: (p: Pick<NotificationPrefs, 'emailEnabled'>) => api<NotificationPrefs>('/api/notifications/prefs', { method: 'PUT', json: p }),
};

export const meApi = {
  outbox: (limit = 20) => api<MyOutboxPage>('/api/me/outbox', { query: { limit } }),
  outboxMessage: (id: string) => api<OutboxEmailDetail>(`/api/me/outbox/${enc(id)}`),
};

// ---------------------------------------------------------------- 管理后台
export const adminApi = {
  users: (q?: string, cursor?: string | null) => api<Page<AdminUser>>('/api/admin/users', { query: { q, cursor: cursor ?? undefined } }),
  updateUser: (id: string, patch: { role?: 'admin' | 'member'; disabled?: boolean }) =>
    api<AdminUser>(`/api/admin/users/${enc(id)}`, { method: 'PATCH', json: patch }),
  outbox: (filter: { to?: string; category?: string; status?: string; cursor?: string | null } = {}) =>
    api<Page<OutboxEmailSummary>>('/api/admin/outbox', { query: { ...filter, cursor: filter.cursor ?? undefined } }),
  outboxMessage: (id: string) => api<OutboxEmailDetail>(`/api/admin/outbox/${enc(id)}`),
  jobs: () => api<JobsOverview>('/api/admin/jobs'),
  jobRuns: (filter: { name?: string; status?: string; cursor?: string | null } = {}) =>
    api<Page<JobRun>>('/api/admin/jobs/runs', { query: { ...filter, cursor: filter.cursor ?? undefined } }),
  runJob: (name: string) => api<JobRun>(`/api/admin/jobs/${enc(name)}/run`, { method: 'POST' }),
  replayFailed: (id: string) => api<void>(`/api/admin/jobs/failed/${enc(id)}/replay`, { method: 'POST' }),
  audit: (filter: { actor?: string; action?: string; since?: string; cursor?: string | null } = {}) =>
    api<Page<AuditEntry>>('/api/admin/audit', { query: { ...filter, cursor: filter.cursor ?? undefined } }),
  auditVerify: () => api<AuditVerifyResult>('/api/admin/audit/verify'),
};

// ---------------------------------------------------------------- /lab
export const labApi = {
  /** full=1：带完整的结果 JSON（卡片上的关键指标差值需要） */
  results: (filter: { module?: string; experiment?: string } = {}) =>
    api<Page<LabResultRow>>('/api/lab/results', { query: { ...filter, full: 1 } }).then((p) => normPage(p)),
  result: (runId: string) => api<LabResultRow>(`/api/lab/results/${enc(runId)}`),
  recentRequests: (limit = 200) => api<Page<LabRequestRecord>>('/api/lab/requests/recent', { query: { limit } }),
  selfCheck: () => api<Record<string, unknown>>('/api/lab/self-check'),
};

/** 不经 JSON 的原始请求（A/B 运行器测量时用） */
export { apiFetch };
