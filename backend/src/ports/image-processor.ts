// backend/src/ports/image-processor.ts （总纲 §4.2，照录；ImageFailure 为 04 组文档登记的细化）
import type { Adapter } from './common.js';

export interface ImageJob { photoId: string; rawKey: string; ownerId: string }
export interface ImageMeta { width: number; height: number; format: string; dominantColor: string; takenAt?: string }
export interface ImageResult {
  photoId: string;
  variants: Array<{ name: 'thumb_200' | 'display_1080'; key: string; width: number; height: number; bytes: number }>;
  meta: ImageMeta;
  processedBy: { driver: 'inline' | 'worker' | 'lambda'; durationMs: number; coldStart?: boolean; host: string };
}
/** 04 组细化：永久错误（格式不支持、超过像素上限、文件损坏）由执行方直接报告，不重试 */
export interface ImageFailure { photoId: string; error: string; permanent: true; processedBy: ImageResult['processedBy'] }

export interface ImageProcessorPort extends Adapter {
  readonly placement: 'inline' | 'worker' | 'lambda';
  /** inline: 当场处理（进程内信号量 IMAGE_INLINE_CONCURRENCY）；worker: queue.enqueue('image.process')；
   *  lambda: 由 S3→EventBridge→Lambda 触发（IMAGE_TRIGGER=eventbridge|buffer-queue），这里只登记“等待结果” */
  submit(job: ImageJob): Promise<{ mode: 'sync'; result: ImageResult } | { mode: 'async'; expectedBy: string }>;
  /** lambda 档 + IMAGE_RESULT_CHANNEL=callback：校验带时间戳的 HMAC 回调（POST /internal/hooks/image-processed，±300 秒） */
  acceptCallback?(rawBody: Buffer, headers: { signature: string; timestamp: string }): Promise<ImageResult | ImageFailure>;
  /** lambda 档 + IMAGE_RESULT_CHANNEL=queue：worker 从模块自带的结果队列取到消息后调用 */
  acceptResult?(message: unknown): Promise<ImageResult | ImageFailure>;
  /** 对账：PROCESSING 超时的照片重新提交或标记 FAILED（scheduler 的 image.reconcile 调用） */
  reconcile(stuckBefore: Date): Promise<{ resubmitted: number; failed: number }>;
}
// 渲染核心在 packages/image-core（sharp），inline/worker、Lambda 与 workflow 的缩略图任务共用同一份代码，保证对比公平。
// 写回规则：READY 可覆盖 UPLOADING/PROCESSING/FAILED，永不覆盖 READY/BLOCKED；永久错误直接写 FAILED，不重试。
