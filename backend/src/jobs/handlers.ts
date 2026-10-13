// backend/src/jobs/handlers.ts —— 5 个队列任务（JobName）的 handler（04#queue 第 3 节）
//
// 两个进程启动时都经 bindJobs() 绑定；实际由谁消费取决于 QueuePort.semantics.consumer。
// handler 必须幂等：at-least-once（sqs）时先查 processed_jobs（dedupKey 或 job.id），已处理直接返回，成功后再写入。
import type { Container } from '../container.js';
import { asLocalImageProcessor, isImageProcessingFailed } from '../adapters/image-processing/inline.js';
import type { ClickEvent } from '../ports/analytics.js';
import type { EmailMessage } from '../ports/email.js';
import type { ImageFailure, ImageJob, ImageResult } from '../ports/image-processor.js';
import type { NotificationEvent } from '../ports/notifier.js';
import type { JobEnvelope, JobHandler, JobName } from '../ports/queue.js';
import { isJobProcessed, markJobProcessed } from '../repositories/job-runs.js';
import { fanout } from '../services/notifications.js';
import { handleImageOutcome, pipelineDeps, tagPhoto, type ImageTagPayload } from '../services/photo-pipeline.js';

/** at-least-once 投递时的去重包装（sync / memory 不需要，省去两次查询） */
export function idempotent(c: Container, handler: JobHandler): JobHandler {
  if (c.queue.semantics.delivery !== 'at-least-once') return handler;
  return async (job) => {
    const key = job.dedupKey ?? job.id;
    if (await isJobProcessed(c.db, key)) return;
    await handler(job);
    await markJobProcessed(c.db, key, job.name);
  };
}

/** image.process（IMAGE_PROCESSOR=worker）：在消费者进程内渲染，然后走统一的写回与后续步骤 */
export async function imageProcess(c: Container, job: JobEnvelope<ImageJob>): Promise<void> {
  const proc = asLocalImageProcessor(c.images) ?? asLocalImageProcessor(c.inlineImages);
  if (!proc) throw new Error('image.process：当前进程没有本地图片处理器');
  let outcome: ImageResult | ImageFailure;
  try {
    outcome = await proc.process(job.payload);
  } catch (e) {
    if (!isImageProcessingFailed(e)) throw e;          // 暂时性错误：交给队列重试
    outcome = { ...e.failure, photoId: job.payload.photoId };
  }
  await handleImageOutcome(pipelineDeps(c), outcome, { attempt: job.attempt });
}

/** image.tag：标签与审核（tagging 非权威：失败只记录，不让任务重试刷屏） */
export async function imageTag(c: Container, job: JobEnvelope<ImageTagPayload>): Promise<void> {
  await tagPhoto(pipelineDeps(c), job.payload);
}

/** notify.fanout：NotifierPort 负责站外渠道扇出（站内信已由 services/notifications.ts 的 notify() 写入；失败只记日志） */
export async function notifyFanout(c: Container, job: JobEnvelope<NotificationEvent>): Promise<void> {
  await fanout({ notifier: c.notifier, logger: c.logger }, job.payload);
}

/** email.send：EmailPort 发送（outbox 写 .eml；ses 调 SendEmail）；dedupKey 防止重复发信 */
export async function emailSend(c: Container, job: JobEnvelope<EmailMessage>): Promise<void> {
  await c.email.send(job.payload);
}

/** analytics.flush：payload.events 存在时先 track，然后把驱动的缓冲写出 */
export async function analyticsFlush(c: Container, job: JobEnvelope<{ events?: ClickEvent[]; probe?: boolean }>): Promise<void> {
  const events = job.payload?.events;
  if (Array.isArray(events) && events.length) await c.analytics.track(events);
  const flush = (c.analytics as { flush?: () => Promise<void> }).flush;
  if (typeof flush === 'function') await flush.call(c.analytics);
}

export function jobHandlers(c: Container): Record<JobName, JobHandler> {
  return {
    'image.process': idempotent(c, (j) => imageProcess(c, j as JobEnvelope<ImageJob>)),
    'image.tag': idempotent(c, (j) => imageTag(c, j as JobEnvelope<ImageTagPayload>)),
    'notify.fanout': idempotent(c, (j) => notifyFanout(c, j as JobEnvelope<NotificationEvent>)),
    'email.send': idempotent(c, (j) => emailSend(c, j as JobEnvelope<EmailMessage>)),
    'analytics.flush': idempotent(c, (j) => analyticsFlush(c, j as JobEnvelope<{ events?: ClickEvent[] }>)),
  };
}
