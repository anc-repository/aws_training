// 上传入口：按 capabilities 自动选择策略（总纲 12.2）。
//   - F6.upload（任何 storage 驱动）：逐文件签名 URL —— local 签名直传与 S3 预签名是同一条前端流程，只有徽章不同；
//   - F14.directUpload：via=identity-pool:none → 前缀令牌分片（多文件、可续传）；via=identity-pool:cognito → STS 直传（本轮只留接口）。
// 自动规则：一次选了多个文件、或单个文件大于两个分片时走 F14；否则走 F6。用户也可以手动指定。
import type { CapabilitiesResponse } from '@cloudalbum/contracts';
import { photosApi, uploadsApi } from '../api/endpoints';
import type { Photo } from '../api/types';
import { identityPoolUpload } from './identityPoolUpload';
import { DEFAULT_PART_SIZE, prefixTokenUpload } from './prefixTokenUpload';
import { signedUrlUpload } from './signedUrlUpload';
import {
  UploadStrategyUnavailableError, type MultipartContext, type UploadContext, type UploadStrategyId,
} from './types';

export type UploadPreference = 'auto' | 'single' | 'multi';

export interface StrategyChoice {
  id: UploadStrategyId;
  /** 为什么选它（显示在上传页） */
  reason: string;
  /** capabilities.features 中提供它的 module:driver */
  via: string[];
}

export function storageDriver(caps: CapabilitiesResponse): string {
  return caps.features['F6.upload']?.via?.[0]?.split(':')[1] ?? caps.modules.storage?.driver ?? 'local';
}

export function directUploadVia(caps: CapabilitiesResponse): string {
  return caps.features['F14.directUpload']?.via?.[0] ?? `identity-pool:${caps.modules['identity-pool']?.driver ?? 'none'}`;
}

export function chooseStrategy(
  caps: CapabilitiesResponse,
  files: ReadonlyArray<Pick<File, 'size'>>,
  preference: UploadPreference = 'auto',
): StrategyChoice {
  const f6 = caps.features['F6.upload'];
  const f14 = caps.features['F14.directUpload'];
  const f6Via = f6?.via ?? [`storage:${caps.modules.storage?.driver ?? 'local'}`];
  const f14Via = f14?.via ?? [directUploadVia(caps)];
  const f14Enabled = f14?.enabled !== false;
  const big = files.some((f) => f.size > 2 * DEFAULT_PART_SIZE);
  const wantMulti = preference === 'multi' || (preference === 'auto' && (files.length > 1 || big));
  if (wantMulti && f14Enabled) {
    const sts = f14Via.some((v) => v === 'identity-pool:cognito');
    return {
      id: sts ? 'identity-pool' : 'prefix-token',
      reason: preference === 'multi' ? '手动选择多文件直传（F14）' : files.length > 1 ? `一次上传 ${files.length} 个文件（F14）` : '大文件分片上传（F14）',
      via: f14Via,
    };
  }
  return {
    id: 'signed-url',
    reason: wantMulti && !f14Enabled ? `F14 不可用：${f14?.reason ?? '未启用'}；逐文件上传（F6）` : '逐文件签名 URL 上传（F6）',
    via: f6Via,
  };
}

/** 执行一个文件的上传；STS 策略不可用时退回 F6 */
export async function uploadFile(file: File, strategy: UploadStrategyId, ctx: MultipartContext = {}): Promise<Photo> {
  if (strategy === 'prefix-token') return prefixTokenUpload(file, ctx);
  if (strategy === 'identity-pool') {
    try {
      const session = await uploadsApi.openSession();
      if (session.mode === 'sts') {
        return await identityPoolUpload(file, { ...ctx, session, credentials: uploadsApi.credentials });
      }
      // 后端退回了前缀令牌（identity-pool=cognito:error-fallback）
      return await prefixTokenUpload(file, { ...ctx, session });
    } catch (e) {
      if (!(e instanceof UploadStrategyUnavailableError)) throw e;
      return signedUrlUpload(file, ctx);
    }
  }
  return signedUrlUpload(file, ctx as UploadContext);
}

export interface PollOptions {
  signal?: AbortSignal;
  /** 首次间隔，默认 1s；指数退避到 maxMs（默认 5s） */
  initialMs?: number;
  maxMs?: number;
  timeoutMs?: number;
  onUpdate?: (p: Photo) => void;
  /** 测试注入 */
  sleep?: (ms: number) => Promise<void>;
  get?: (id: string) => Promise<Photo>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 处理中（PROCESSING / UPLOADING）的照片按退避间隔轮询 GET /api/photos/:id，直到 READY / FAILED / BLOCKED（04 组第 1 节） */
export async function pollUntilSettled(photo: Photo, opts: PollOptions = {}): Promise<Photo> {
  const sleep = opts.sleep ?? defaultSleep;
  const get = opts.get ?? ((id: string) => photosApi.get(id));
  let delay = opts.initialMs ?? 1000;
  const max = opts.maxMs ?? 5000;
  const deadline = Date.now() + (opts.timeoutMs ?? 10 * 60_000);
  let cur = photo;
  while (cur.status === 'PROCESSING' || cur.status === 'UPLOADING') {
    if (opts.signal?.aborted || Date.now() > deadline) return cur;
    await sleep(delay);
    delay = Math.min(max, Math.round(delay * 1.6));
    cur = await get(cur.id);
    opts.onUpdate?.(cur);
  }
  return cur;
}

export { signedUrlUpload, prefixTokenUpload, identityPoolUpload };
export type { UploadStrategyId, UploadContext, MultipartContext };
