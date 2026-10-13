// 前端使用的 HTTP 接口数据形状（JSON 一律 camelCase，时间为 ISO 8601 UTC 字符串）。
// 端点名取自总纲 2.8 / 2.9 / 7.3 / 8.x 与各组文档；文档没写死的请求 / 响应字段由前端在这里约定，
// 并登记在 docs/implementation-notes.md 的“## frontend”小节，供后端路由实现者对齐。
import type { BypassKey, ModuleId } from '@cloudalbum/contracts';

export interface Page<T> {
  items: T[];
  nextCursor?: string | null;
  /** 部分路由（feed、photos、social）用 next 表示游标；endpoints.ts 的 normPage() 统一成 nextCursor */
  next?: string | null;
}

// ---------------------------------------------------------------- 用户与认证（F1–F4）
export interface Me {
  id: string;
  email: string;
  displayName: string;
  emailVerified: boolean;
  role: 'admin' | 'member';
  groups?: string[];
  plan: string;
  provider: 'local' | 'cognito';
  mfaEnabled?: boolean;
  /** auth=local 注册后的“未验证”受限会话：只允许 /api/auth/*、/api/me、/api/me/outbox* */
  restricted?: boolean;
}

export type LoginResponse =
  | { kind: 'tokens'; user?: Me }
  | { kind: 'mfa_required'; challengeId: string }
  | { kind: 'reset-required'; message?: string };

export interface RegisterResponse {
  userId?: string;
  needsConfirmation: boolean;
  /** 注册后是否已签发受限会话（可直接打开 /me/outbox 完成验证） */
  restrictedSession?: boolean;
}

export interface SocialSessionToken {
  token: string;
  expiresAt: string;
}

// ---------------------------------------------------------------- 相册与照片（F5–F8）
export type PhotoStatus = 'UPLOADING' | 'PROCESSING' | 'READY' | 'FAILED' | 'BLOCKED';
export type Visibility = 'public' | 'private';

/** photos.processed_by：随照片保存，与当前驱动无关（徽章“缩略图由 EC2 生成 · {durationMs} ms”） */
export interface ProcessedBy {
  driver: 'inline' | 'worker' | 'lambda' | string;
  durationMs: number;
  host?: string;
  coldStart?: boolean;
}

export interface PhotoLabel {
  name: string;
  confidence: number;
  source: 'basic' | 'rekognition' | string;
}

export interface MediaUrls {
  thumb?: string | null;
  display?: string | null;
  original?: string | null;
}

export interface Photo {
  id: string;
  ownerId: string;
  ownerName?: string;
  /** 后端 PhotoDto 的写法；normPhoto() 据此补 ownerName */
  owner?: { id: string; displayName: string };
  likedByMe?: boolean;
  isOwner?: boolean;
  updatedAt?: string;
  albumId: string | null;
  filename: string;
  contentType: string;
  sizeBytes: number | null;
  status: PhotoStatus;
  visibility: Visibility;
  title: string | null;
  caption: string | null;
  width: number | null;
  height: number | null;
  dominantColor: string | null;
  takenAt: string | null;
  createdAt: string;
  readyAt: string | null;
  labels?: PhotoLabel[];
  processedBy?: ProcessedBy | null;
  workflow?: { driver: string; executionId?: string; attempts?: number } | null;
  failureReason?: string | null;
  /** 由后端 MediaUrlBuilder 生成：local 为带 HMAC 的 /media/...，s3 为预签名 URL，cdn 启用后改写为 CDN 域名 */
  urls: MediaUrls;
  counters?: { likes: number; comments: number };
}

export interface Album {
  id: string;
  ownerId: string;
  title: string;
  description: string | null;
  visibility: Visibility;
  coverPhotoId: string | null;
  coverUrl?: string | null;
  isDefault: boolean;
  photoCount?: number;
  createdAt: string;
  updatedAt: string;
}

export interface AlbumDetail {
  album: Album;
  photos: Photo[];
  nextCursor?: string | null;
}

// ---------------------------------------------------------------- 上传（F6 / F14）
/** StoragePort.UploadTarget（ports/storage.ts）：local 为 HMAC 签名的 /api/storage/upload?...，s3 为预签名 URL */
export interface UploadTarget {
  method: 'PUT';
  url: string;
  headers: Record<string, string>;
  expiresAt: string;
}

export interface CreatePhotoRequest {
  filename: string;
  contentType: string;
  sizeBytes: number;
  /** 后端 photos 路由的字段名（与 sizeBytes 同值，两个都发） */
  size?: number;
  albumId?: string | null;
  title?: string | null;
  /** 'single' = F6 逐文件签名 URL（默认）；'multipart' = F14 前缀令牌分片，后端同时返回 uploadId */
  transfer?: 'single' | 'multipart';
}

export interface CreatePhotoResponse {
  photo: Photo;
  photoId?: string;
  /** 原图键 raw/<userId>/<photoId>.<ext>（F14 的分片键）；后端没给时由会话前缀 + photoId + 扩展名推出 */
  rawKey?: string;
  /** F6：浏览器原样执行的 PUT（URL + 头），没有驱动分支 */
  upload?: UploadTarget;
  uploadTarget?: UploadTarget;
  maxBytes?: number;
  /** F14：分片上传 ID（storage=s3 时由后端 CreateMultipartUpload 得到）；没给时约定为 photoId */
  uploadId?: string;
}

/** DirectUploadPort.openSession 的返回（ports/direct-upload.ts） */
export type DirectUploadSession =
  | {
      mode: 'token';
      token: string;
      expiresAt: string;
      prefix: string;
      partSize: number;
      partUrl: '/api/uploads/parts:sign' | '/api/storage/upload';
      fallback?: true;
    }
  | {
      mode: 'sts';
      region: string;
      bucket: string;
      prefix: string;
      partSize: number;
      credentialsUrl: '/api/uploads/credentials';
    };

export interface TempAwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiration: string;
  identityId: string;
  region: string;
  bucket: string;
  prefix: string;
}

export interface CompletedPart {
  part: number;
  etag?: string;
}

export interface CompletePhotoRequest {
  uploadId?: string;
  parts?: CompletedPart[];
}

// ---------------------------------------------------------------- 社交（F9 / F11）
export interface PhotoCounters {
  likes: number;
  comments: number;
  likedByMe?: boolean;
}

export interface Comment {
  id: string;
  photoId: string;
  userId: string;
  userName?: string;
  /** 后端 social 路由的写法；social.ts 据此补 userName */
  user?: { id: string; displayName: string };
  mine?: boolean;
  text: string;
  createdAt: string;
}

export interface ShareLink {
  token: string;
  url: string;
  apiUrl?: string;
  photoId: string;
  createdAt?: string;
  expiresAt: string;
}

export interface SharedPhoto {
  photo: Photo;
  expiresAt: string;
  sharedBy?: string;
  share?: { token: string; expiresAt: string; createdAt?: string };
}

// ---------------------------------------------------------------- 通知与邮件（F10 / X16）
export interface NotificationItem {
  id: string;
  type: 'comment.created' | 'like.created' | 'photo.blocked' | 'report.ready' | string;
  title: string;
  body: string;
  link: string | null;
  data?: Record<string, unknown> | null;
  readAt: string | null;
  createdAt: string;
}

export interface NotificationPrefs {
  emailEnabled: boolean;
  /** notification=sns 时：邮件订阅状态（需要点击确认邮件） */
  sns?: { status: 'none' | 'pending' | 'confirmed' | string; endpoint?: string } | null;
}

export type OutboxCategory = 'verification' | 'password-reset' | 'notification' | 'report' | 'system' | string;

export interface OutboxEmailSummary {
  id: string;
  messageId: string;
  to: string[];
  subject: string;
  category: OutboxCategory;
  transport: 'outbox' | 'ses' | string;
  status: 'queued' | 'sent' | 'failed' | string;
  deliveryStatus: 'none' | 'delivered' | 'bounced' | 'complained' | 'rejected' | 'delayed' | string;
  error?: string | null;
  userId?: string | null;
  createdAt: string;
  sentAt: string | null;
}

export interface OutboxEmailDetail extends OutboxEmailSummary {
  from?: string;
  html?: string | null;
  text?: string | null;
  /** 只有 transport=outbox（或被沙箱策略改写进 outbox）的邮件才有正文 */
  hasBody?: boolean;
  emlUrl?: string | null;
}

export interface MyOutboxPage extends Page<OutboxEmailSummary> {
  /** featureFlags['email.selfPreview'] */
  selfPreview?: boolean;
  transport?: 'outbox' | 'ses' | string;
}

// ---------------------------------------------------------------- 管理后台（F12）
export interface AdminUser {
  id: string;
  email: string;
  displayName: string;
  role: 'admin' | 'member';
  plan: string;
  provider: 'local' | 'cognito';
  emailVerified: boolean;
  mfaEnabled?: boolean;
  disabled: boolean;
  lockedUntil?: string | null;
  createdAt: string;
  photoCount?: number;
}

export interface JobRun {
  runId: string;
  name: string;
  subjectId?: string | null;
  scheduledAt?: string | null;
  startedAt: string;
  finishedAt?: string | null;
  status: 'running' | 'ok' | 'failed' | 'skipped-locked' | 'skipped-duplicate' | string;
  host: string;
  trigger: 'cron' | 'eventbridge' | 'manual' | 'pipeline' | string;
  attempt?: number;
  executor?: string | null;
  error?: string | null;
}

export interface ScheduledJobInfo {
  name: string;
  schedule: string;
  description?: string;
  lastRun?: JobRun | null;
  nextRunAt?: string | null;
}

export interface FailedJob {
  id: string;
  name: string;
  attempts: number;
  firstEnqueuedAt?: string;
  lastError?: string | null;
  failedAt: string;
}

export interface JobsOverview {
  queue: { driver: string; depth?: number; inFlight?: number; dlqDepth?: number; detail?: string };
  scheduler: { driver: string; jobs: ScheduledJobInfo[] };
  failed: FailedJob[];
}

export interface AuditEntry {
  id: number | string;
  ts: string;
  actorType: 'user' | 'admin' | 'system' | 'anonymous' | string;
  actorId?: string | null;
  actorEmail?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  result: 'success' | 'denied' | 'error' | string;
  sourceIp?: string | null;
  requestId?: string | null;
  awsPrincipal?: string | null;
  details?: Record<string, unknown> | string | null;
}

export interface AuditVerifyResult {
  ok: boolean;
  checked: number;
  brokenAt?: string | number | null;
  detail?: string;
}

// ---------------------------------------------------------------- /lab（§7.3、§8）
export interface LatencyStats {
  count?: number;
  p50?: number;
  p95?: number;
  p99?: number;
  errors?: number;
  calls?: number;
}

/** experiments/_lib/schema/result.schema.json（总纲 8.2） */
export interface ExperimentResult {
  schemaVersion: number;
  runId: string;
  module: ModuleId | string;
  experiment: string;
  label: string;
  forced: boolean;
  startedAt: string;
  finishedAt: string;
  target?: string;
  params?: Record<string, unknown>;
  environment?: {
    profile?: string;
    deployMode?: string;
    instanceType?: string;
    drivers?: Record<string, string>;
    capabilitiesHash?: string;
  };
  client?: { requests?: number; errors?: number; latencyMs?: Record<string, LatencyStats> };
  server?: {
    routes?: Record<string, LatencyStats>;
    ports?: Record<string, LatencyStats>;
    host?: Record<string, number>;
    business?: Record<string, number>;
  };
  faults?: Array<{ at: string; script: string; exitCode?: number }>;
  notes?: string;
}

export interface LabResultRow {
  runId: string;
  module: string;
  experiment: string;
  label: string;
  startedAt: string;
  finishedAt: string;
  forced: boolean;
  uploadedAt?: string;
  result?: ExperimentResult;
}

export interface LabRequestRecord {
  at: string;
  method: string;
  route: string;
  status: number;
  durationMs: number;
  path: string;
  requestId?: string;
  runId?: string;
  label?: string;
}

export interface ApiErrorBody {
  error: string;
  message?: string;
  details?: unknown;
  requestId?: string;
}

export type { BypassKey };
