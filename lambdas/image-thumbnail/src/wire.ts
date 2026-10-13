/**
 * lambdas/image-thumbnail —— 结果回写的线上格式（Lambda → EC2）
 *
 * callback 通道：POST {IMAGE_CALLBACK_URL}，请求体为 WireMessage 的 JSON，请求头
 *   X-CloudAlbum-Timestamp: <unix 秒>
 *   X-CloudAlbum-Signature: v1=<hex(HMAC-SHA256(callback-hmac-key, timestamp + "." + rawBody))>
 * queue 通道：SendMessage 到模块自带的结果队列，消息体为同一个 JSON（不签名：只有本模块的执行角色有 sqs:SendMessage）。
 *
 * 后端（backend/src/adapters/image-processing/lambda.ts）用 zod 校验同一格式；两边各自保留一份定义（Lambda 不依赖 backend）。
 */
import { createHmac } from 'node:crypto';

export const WIRE_VERSION = 1 as const;
export const HEADER_TIMESTAMP = 'X-CloudAlbum-Timestamp';
export const HEADER_SIGNATURE = 'X-CloudAlbum-Signature';

export type WireVariantName = 'thumb_200' | 'display_1080';

export interface WireVariant { name: WireVariantName; key: string; width: number; height: number; bytes: number }
export interface WireMeta { width: number; height: number; format: string; dominantColor: string; takenAt?: string }
export interface WireProcessedBy { driver: 'lambda'; durationMs: number; coldStart?: boolean; host: string }

export interface WireResult {
  v: typeof WIRE_VERSION;
  kind: 'result';
  photoId: string;
  rawKey: string;
  variants: WireVariant[];
  meta: WireMeta;
  processedBy: WireProcessedBy;
  requestId?: string;
  finishedAt: string;
}

/** 永久错误（格式不支持、超过像素上限、文件损坏）：直接回写 FAILED，不重试 */
export interface WireFailure {
  v: typeof WIRE_VERSION;
  kind: 'failure';
  photoId: string;
  rawKey: string;
  error: string;
  permanent: true;
  processedBy: WireProcessedBy;
  requestId?: string;
  finishedAt: string;
}

export type WireMessage = WireResult | WireFailure;

export function signCallback(key: string, timestamp: string, rawBody: string | Buffer): string {
  return `v1=${createHmac('sha256', key).update(`${timestamp}.`).update(rawBody).digest('hex')}`;
}

/** 原图键 `raw/<userId>/<photoId>.<ext>`（userId 为 `_probe` 时是 scripts/module 的端到端探针） */
export function parseRawKey(key: string, prefix = 'raw/'): { userId: string; photoId: string; ext: string } | null {
  if (!key.startsWith(prefix)) return null;
  const m = /^([^/]+)\/([^/]+)\.([A-Za-z0-9]+)$/.exec(key.slice(prefix.length));
  if (!m) return null;
  return { userId: m[1]!, photoId: m[2]!, ext: m[3]!.toLowerCase() };
}
