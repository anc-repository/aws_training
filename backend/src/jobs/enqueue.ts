// backend/src/jobs/enqueue.ts —— 非关键任务的入队（04#queue 第 1 节“各调用方按任务的重要性处理”）
//
// image.tag、notify.fanout、email.send、analytics.flush 失败不影响主流程：捕获异常、记日志后照常返回。
// sync 驱动下 handler 的异常已由适配器写入本地死信（job_runs，name = queue.<任务名>），这里不重复记录。
import { isNotImplemented } from '../errors.js';
import type { Logger } from '../ports/logger.js';
import type { JobName, QueuePort } from '../ports/queue.js';

export interface EnqueueDeps { queue: QueuePort; logger?: Logger }

export async function enqueueSafe<P>(d: EnqueueDeps, name: JobName, payload: P, opts?: { delaySec?: number; dedupKey?: string }): Promise<{ jobId: string; mode: 'inline' | 'queued' } | null> {
  try {
    return await d.queue.enqueue(name, payload, opts);
  } catch (e) {
    if (isNotImplemented(e)) {
      d.logger?.debug?.('queue.enqueue_skipped', { job: name, reason: (e as Error).message });
    } else {
      d.logger?.warn('queue.enqueue_failed', { job: name, error: (e as Error)?.message ?? String(e) });
    }
    return null;
  }
}
