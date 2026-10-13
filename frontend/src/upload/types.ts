// 上传策略共用的类型。
import type { DirectUploadSession, Photo } from '../api/types';
import type { PutImpl } from './http';

export type UploadStage = 'create' | 'upload' | 'complete' | 'processing' | 'ready' | 'failed';

export type UploadStrategyId = 'signed-url' | 'prefix-token' | 'identity-pool';

export interface UploadContext {
  albumId?: string | null;
  signal?: AbortSignal;
  onStage?: (stage: UploadStage) => void;
  onProgress?: (loaded: number, total: number) => void;
  onCreated?: (photo: Photo) => void;
  /** 测试注入 */
  put?: PutImpl;
}

/** F14 的续传状态：同一个文件再次上传时沿用 photoId / uploadId，只补传缺失的分片 */
export interface ResumeState {
  photoId: string;
  rawKey: string;
  uploadId: string;
  /** part → ETag（storage=s3 时合并需要；local 为空字符串） */
  done: Record<number, string>;
}

export interface MultipartContext extends UploadContext {
  session?: Extract<DirectUploadSession, { mode: 'token' }>;
  resume?: ResumeState;
  onResumeState?: (s: ResumeState) => void;
  /** 打开新会话（令牌过期时） */
  openSession?: () => Promise<DirectUploadSession>;
}

export class UploadStrategyUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UploadStrategyUnavailableError';
  }
}
