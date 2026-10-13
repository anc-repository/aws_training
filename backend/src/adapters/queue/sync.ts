// backend/src/adapters/queue/sync.ts —— QueuePort 的 `sync` 驱动（本地实现，L0 默认）
//
// enqueue() 直接 await handler(job)，返回 { mode: 'inline' }：没有排队、没有重试（04#queue 第 1 节）。
// 语义 { durable: false, consumer: 'inline', delivery: 'inline' }。出错时异常抛回调用方，同时写一行本地死信
// （job_runs，name = queue.<任务名>，见 repositories/job-runs.ts）；非关键任务由调用方捕获（jobs/enqueue.ts 的 enqueueSafe）。
// 必须先 bind（jobs/index.ts 的 bindJobs，api 与 worker 两个进程启动时都执行）。
import { randomUUID } from 'node:crypto';
import type { AdapterDeps } from '../types.js';
import type { AdapterMeta, ProbeResult } from '../../ports/common.js';
import type { JobEnvelope, JobHandler, JobName, QueuePort } from '../../ports/queue.js';
import { nowIso } from '../../db/dialect.js';
import { markPath } from '../../observability/request-context.js';
import { countQueueFailuresSince, recordQueueFailure } from '../../repositories/job-runs.js';

/** 本地档共用：把失败写入本地死信（job_runs）；数据库不可用时只记日志 */
export async function recordLocalFailure(deps: AdapterDeps, job: JobEnvelope, err: unknown, source: 'sync' | 'memory'): Promise<void> {
  const message = (err as Error)?.message ?? String(err);
  deps.logger?.warn('queue.job_failed', { job: job.name, jobId: job.id, attempt: job.attempt, source, error: message });
  if (!deps.db) return;
  try {
    await recordQueueFailure(deps.db, {
      jobId: job.id, name: job.name, payload: job.payload, attempts: job.attempt, error: message, source, enqueuedAt: job.enqueuedAt,
    });
  } catch (e) {
    deps.logger?.error('queue.record_failure_failed', { error: e as Error });
  }
}

/** 本地档共用的探针：最近 5 分钟新增的本地死信 → degraded */
export async function localQueueHealth(deps: AdapterDeps, base: string): Promise<ProbeResult> {
  if (!deps.db) return { status: 'ok', detail: base };
  const since = new Date(Date.now() - 5 * 60_000).toISOString();
  const failed = await countQueueFailuresSince(deps.db, since);
  return failed > 0
    ? { status: 'degraded', detail: `${base} · 最近 5 分钟有 ${failed} 个任务失败（见 /admin/jobs）`, data: { failed5m: failed } }
    : { status: 'ok', detail: base, data: { failed5m: 0 } };
}

export function newEnvelope<P>(name: JobName, payload: P, opts: { dedupKey?: string } = {}): JobEnvelope<P> {
  return { id: randomUUID(), name, payload, attempt: 1, enqueuedAt: nowIso(), ...(opts.dedupKey ? { dedupKey: opts.dedupKey } : {}) };
}

export class SyncQueue implements QueuePort {
  readonly meta: AdapterMeta = { module: 'queue', driver: 'sync', awsService: null, authoritative: true };
  readonly semantics: QueuePort['semantics'] = { durable: false, consumer: 'inline', delivery: 'inline' };
  private readonly handlers = new Map<JobName, JobHandler>();
  private running = 0;

  constructor(protected readonly deps: AdapterDeps) {}

  async probe(_opts?: { deep?: boolean }): Promise<ProbeResult> {
    return localQueueHealth(this.deps, `任务在请求内当场执行（sync）· 已绑定 ${this.handlers.size} 个 handler`);
  }

  bind(handlers: Partial<Record<JobName, JobHandler>>): void {
    for (const [name, h] of Object.entries(handlers) as Array<[JobName, JobHandler | undefined]>) if (h) this.handlers.set(name, h);
  }

  async enqueue<P>(name: JobName, payload: P, opts?: { delaySec?: number; dedupKey?: string }): Promise<{ jobId: string; mode: 'inline' | 'queued' }> {
    const handler = this.handlers.get(name);
    if (!handler) throw new Error(`queue(sync): 任务 ${name} 没有绑定 handler（先调用 jobs/index.ts 的 bindJobs）`);
    const job = newEnvelope(name, payload, opts?.dedupKey ? { dedupKey: opts.dedupKey } : {});
    markPath('queue', 'sync:inline');
    this.running++;
    try {
      await handler(job);
    } catch (e) {
      await recordLocalFailure(this.deps, job, e, 'sync');
      throw e;
    } finally {
      this.running--;
    }
    return { jobId: job.id, mode: 'inline' };
  }

  /** sync 没有可消费的队列：阻塞到 signal 终止 */
  async consume(opts: { concurrency: number; signal: AbortSignal }): Promise<void> {
    if (opts.signal.aborted) return;
    await new Promise<void>((resolve) => opts.signal.addEventListener('abort', () => resolve(), { once: true }));
  }

  async stats(): Promise<{ depth: number; inFlight: number; dlqDepth?: number; oldestAgeSec?: number }> {
    return { depth: 0, inFlight: this.running };
  }

  async drain(_timeoutSec: number): Promise<{ remaining: number }> {
    return { remaining: 0 };
  }

  boundJobs(): JobName[] {
    return [...this.handlers.keys()];
  }
}
