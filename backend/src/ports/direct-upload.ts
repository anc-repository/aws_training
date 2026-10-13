// backend/src/ports/direct-upload.ts   （identity-pool 模块；驱动 none | cognito，由 IDENTITY_POOL_ID 是否为空推导；总纲 §4.2，照录）
import type { Principal } from './auth.js';
import type { Adapter } from './common.js';

// F14 的端点（第 3 轮与 02#identity-pool 对齐）：
//   POST /api/uploads/session          开会话（X-Compare-Bypass: identity-pool 只在这里有效）
//   PUT  /api/storage/upload?key&uploadId&part   storage=local 的分片，令牌在请求头 Authorization: CA-Upload <令牌>
//   GET  /api/storage/upload/parts?uploadId      已收到的分片（续传）
//   POST /api/uploads/parts:sign        storage=s3 时逐片换取预签名 UploadPart URL（同样带 CA-Upload 令牌）
//   GET  /api/uploads/credentials       cognito：用 HttpOnly Cookie 中的 ID 令牌换取 / 刷新 STS 临时凭证
export type DirectUploadSession =
  | { mode: 'token'; token: string; expiresAt: string; prefix: string;              // none：raw/<userId>/；HMAC 令牌（upload-hmac-key）
      partSize: number; partUrl: '/api/storage/upload' | '/api/uploads/parts:sign';
      fallback?: true }                                                             // cognito 故障时退回 none 的令牌（identity-pool=cognito:error-fallback）
  | { mode: 'sts'; region: string; bucket: string; prefix: string;                  // cognito：暂存桶 private/<identityId>/
      partSize: number; credentialsUrl: '/api/uploads/credentials' };

/** STS 临时凭证（cognito 驱动经 GetCredentialsForIdentity 取得，下发给浏览器） */
export interface TempAwsCredentials {
  accessKeyId: string; secretAccessKey: string; sessionToken: string; expiration: string;
  identityId: string; region: string; bucket: string; prefix: string;
}

export interface DirectUploadPort extends Adapter {
  openSession(who: Principal, opts?: { bypass?: boolean }): Promise<DirectUploadSession>;
  authorizePart?(token: string, key: string, uploadId: string, part: number): Promise<{ url?: string }>;   // none
  credentials?(who: Principal, idToken: string): Promise<TempAwsCredentials>;                               // cognito
  /** complete 时校验大小、类型与文件头，得到原图键 raw/<userId>/<photoId>.<ext>；
   *  none：分片在 storage 侧合并（local：拼接 .incoming/<uploadId>/；s3：CompleteMultipartUpload）；
   *  cognito：StoragePort.importObject（服务端 CopyObject）后删除暂存对象 */
  complete(photoId: string, who: Principal): Promise<{ ok: boolean; rawKey?: string; reason?: string }>;
}
