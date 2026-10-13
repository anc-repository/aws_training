// F14（identity-pool=cognito）：STS 临时凭证 + IAM 策略变量，分片直传模块自带的暂存桶 private/<identityId>/<photoId>.<ext>，
// complete 时服务端 CopyObject 导入原图键（02 组 identity-pool 第 2 节）。
//
// 本轮只留接口：identity-pool 不在 MVP 的 8 个模块里，后端以退出码 78 拒绝 IDENTITY_POOL_ID 非空的配置，前端实际不会收到 mode='sts'。
// 实现时在这里动态 import('@aws-sdk/client-s3') 与 '@aws-sdk/lib-storage' 的 Upload（不进首屏包），S3Client 的 credentials
// 配成函数：快过期时重新请求 GET /api/uploads/credentials。
import type { DirectUploadSession, Photo, TempAwsCredentials } from '../api/types';
import { UploadStrategyUnavailableError, type UploadContext } from './types';

export type StsSession = Extract<DirectUploadSession, { mode: 'sts' }>;

export interface IdentityPoolUploadContext extends UploadContext {
  session: StsSession;
  /** GET /api/uploads/credentials（默认实现见 api/endpoints.ts 的 uploadsApi.credentials） */
  credentials: () => Promise<TempAwsCredentials>;
}

/** 暂存键：private/<identityId>/<photoId>.<ext> */
export function stagingKey(identityId: string, photoId: string, filename: string): string {
  const ext = (/\.([A-Za-z0-9]{1,8})$/.exec(filename)?.[1] ?? 'bin').toLowerCase();
  return `private/${identityId}/${photoId}.${ext}`;
}

export async function identityPoolUpload(_file: File, _ctx: IdentityPoolUploadContext): Promise<Photo> {
  throw new UploadStrategyUnavailableError(
    'identity-pool（STS 临时凭证直传）本轮未实现前端上传器；已退回 F6 逐文件签名 URL 上传',
  );
}
