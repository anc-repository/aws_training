// backend/src/adapters/queue/memory.ts —— QueuePort 的 `memory` 驱动（本地档：进程内队列，最多一次，重启即丢）
//
// - enqueue() 立即返回 { mode: 'queued' }；consume() 在本进程内后台执行（04#queue 第 1 节）。
//   api 进程消费 api 入队的任务；worker 进程（定时任务产生的任务）消费自己入队的任务——内存队列不能跨进程；
// - 每个任务名有自己的并发上限：QUEUE_CONCURRENCY 中列出的值，未列出的取 QUEUE_MEMORY_CONCURRENCY；
//   IMAGE_PROCESSOR=worker 时 image.process 的并发取 IMAGE_WORKER_CONCURRENCY；
// - 失败按指数退避重试，最多 QUEUE_MAX_ATTEMPTS 次，仍失败写本地死信（job_runs）；
// - 同一 dedupKey 的任务在排队 / 执行中时不重复入队；
// - 管理员 X-Compare-Bypass: queue 时本次任务当场执行（memory:bypass-inline）；
// - drain() 停止接收新任务并等待排空；close()（SIGTERM）同样先尽量排空，再停止消费循环。
import type { AdapterDeps } from '../types.js';
import type { AdapterMeta, ProbeResult } from '../../ports/common.js';
import type { JobEnvelope, JobHandler, JobName, QueuePort } from '../../ports/queue.js';
import { HttpError } from '../../errors.js';
import { isBypassed, markPath } from '../../observability/request-context.js';
import { localQueueHealth, newEnvelope, recordLocalFailure } from './sync.js';

interface Pending { job: JobEnvelope; visibleAt: number }

export function parseConcurrency(spec: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const part of spec.split(',')) {
    const [name, n] = part.split(':').map((s) => s.trim());
    const v = Number(n);
    if (name && Number.isInteger(v) && v > 0) out.set(name, v);
  }
  return out;
}

export class MemoryQueue implements QueuePort {
  readonly meta: AdapterMeta = { module: 'queue', driver: 'memory', awsService: null, authoritative: true };
  readonly semantics: QueuePort['semantics'] = { durable: false, consumer: 'api', delivery: 'at-most-once' };
  private readonly handlers = new Map<JobName, JobHandler>();
  private readonly pending: Pending[] = [];
  private readonly running = new Map<JobName, number>();
  private readonly activeDedup = new Map<string, string>();
  private readonly limits: Map<string, number>;
  private readonly defaultLimit: number;
  private readonly maxAttempts: number;
  private inFlight = 0;
  private consuming = false;
  private draining = false;
  private closed = false;
  private wake: (() => void) | null = null;
  private readonly idleWaiters = new Set<() => void>();
  private processed = 0;
  private failed = 0;
  private retried = 0;

  constructor(protected readonly deps: AdapterDeps) {
    const q = deps.cfg.queue;
    this.defaultLimit = 'QUEUE_MEMORY_CONCURRENCY' in q ? q.QUEUE_MEMORY_CONCURRENCY : 2;
    this.maxAttempts = q.QUEUE_MAX_ATTEMPTS;
    this.limits = parseConcurrency(q.QUEUE_CONCURRENCY);
    const img = deps.cfg.image;
    if (img.IMAGE_PROCESSOR === 'worker') this.limits.set('image.process', img.IMAGE_WORKER_CONCURRENCY);
  }

  /** 测试与排障用：调整退避（毫秒）。默认 1s、2s、4s…，最长 30s */
  backoffMs = (attempt: number): number => Math.min(30_000, 1000 * 2 ** Math.max(0, attempt - 1));

  async probe(_opts?: { deep?: boolean }): Promise<ProbeResult> {
    const base = `api 进程内存队列（重启即丢）· 排队 ${this.pending.length} · 处理中 ${this.inFlight}${this.consuming ? '' : ' · 消费者未启动'}`;
    const r = await localQueueHealth(this.deps, base);
    return { ...r, data: { ...(r.data ?? {}), depth: this.pending.length, inFlight: this.inFlight, processed: this.processed, failed: this.failed, retried: this.retried, consuming: this.consuming } };
  }

  bind(handlers: Partial<Record<JobName, JobHandler>>): void {
    for (const [name, h] of Object.entries(handlers) as Array<[JobName, JobHandler | undefined]>) if (h) this.handlers.set(name, h);
  }

  private limitOf(name: JobName): number {
    return this.limits.get(name) ?? this.defaultLimit;
  }

  private kick(): void {
    const w = this.wake;
    this.wake = null;
    w?.();
  }

  private notifyIdle(): void {
    if (this.pending.length || this.inFlight) return;
    for (const w of this.idleWaiters) w();
    this.idleWaiters.clear();
  }

  async enqueue<P>(name: JobName, payload: P, opts?: { delaySec?: number; dedupKey?: string }): Promise<{ jobId: string; mode: 'inline' | 'queued' }> {
    const handler = this.handlers.get(name);
    if (!handler) throw new Error(`queue(memory): 任务 ${name} 没有绑定 handler（先调用 jobs/index.ts 的 bindJobs）`);
    const job = newEnvelope(name, payload, opts?.dedupKey ? { dedupKey: opts.dedupKey } : {});
    if (isBypassed('queue')) {
      markPath('queue', 'memory:bypass-inline');
      try {
        await handler(job);
      } catch (e) {
        await recordLocalFailure(this.deps, job, e, 'memory');
        throw e;
      }
      return { jobId: job.id, mode: 'inline' };
    }
    if (this.draining || this.closed) throw new HttpError(503, 'QUEUE_DRAINING', '内存队列正在排空，暂不接收新任务', undefined, { 'Retry-After': '30' });
    if (opts?.dedupKey) {
      const existing = this.activeDedup.get(opts.dedupKey);
      if (existing) {
        markPath('queue', 'memory:queued');
        return { jobId: existing, mode: 'queued' };
      }
      this.activeDedup.set(opts.dedupKey, job.id);
    }
    this.pending.push({ job, visibleAt: Date.now() + Math.max(0, opts?.delaySec ?? 0) * 1000 });
    markPath('queue', 'memory:queued');
    this.kick();
    return { jobId: job.id, mode: 'queued' };
  }

  /** 取出下一个可执行的任务（已到可见时间、该任务名未达并发上限） */
  private next(now: number, totalCap: number): Pending | undefined {
    if (this.inFlight >= totalCap) return undefined;
    for (let i = 0; i < this.pending.length; i++) {
      const p = this.pending[i]!;
      if (p.visibleAt > now) continue;
      if ((this.running.get(p.job.name) ?? 0) >= this.limitOf(p.job.name)) continue;
      this.pending.splice(i, 1);
      return p;
    }
    return undefined;
  }

  private nextVisibleIn(now: number): number | null {
    let min: number | null = null;
    for (const p of this.pending) if (p.visibleAt > now) min = min === null ? p.visibleAt - now : Math.min(min, p.visibleAt - now);
    return min;
  }

  private async run(p: Pending): Promise<void> {
    const { job } = p;
    const handler = this.handlers.get(job.name);
    this.inFlight++;
    this.running.set(job.name, (this.running.get(job.name) ?? 0) + 1);
    try {
      if (!handler) throw new Error(`任务 ${job.name} 没有绑定 handler`);
      await handler(job);
      this.processed++;
      if (job.dedupKey) this.activeDedup.delete(job.dedupKey);
    } catch (e) {
      if (job.attempt < this.maxAttempts && !this.closed) {
        this.retried++;
        this.pending.push({ job: { ...job, attempt: job.attempt + 1 }, visibleAt: Date.now() + this.backoffMs(job.attempt) });
      } else {
        this.failed++;
        if (job.dedupKey) this.activeDedup.delete(job.dedupKey);
        await recordLocalFailure(this.deps, job, e, 'memory');
      }
    } finally {
      this.inFlight--;
      this.running.set(job.name, (this.running.get(job.name) ?? 1) - 1);
      this.kick();
      this.notifyIdle();
    }
  }

  async consume(opts: { concurrency: number; signal: AbortSignal }): Promise<void> {
    if (this.consuming) {
      // 已有消费循环：本次调用只等待终止信号
      if (!opts.signal.aborted && !this.closed) {
        await new Promise<void>((resolve) => opts.signal.addEventListener('abort', () => resolve(), { once: true }));
      }
      return;
    }
    this.consuming = true;
    const totalCap = Math.max(1, opts.concurrency);
    const onAbort = () => this.kick();
    opts.signal.addEventListener('abort', onAbort, { once: true });
    try {
      while (!opts.signal.aborted && !this.closed) {
        const now = Date.now();
        let p: Pending | undefined;
        while ((p = this.next(now, totalCap))) void this.run(p);
        const waitMs = this.nextVisibleIn(now);
        await new Promise<void>((resolve) => {
          const timer = waitMs === null ? null : setTimeout(resolve, Math.max(5, waitMs));
          timer?.unref?.();
          this.wake = () => {
            if (timer) clearTimeout(timer);
            resolve();
          };
        });
      }
    } finally {
      opts.signal.removeEventListener('abort', onAbort);
      this.consuming = false;
    }
  }

  async stats(): Promise<{ depth: number; inFlight: number; dlqDepth?: number; oldestAgeSec?: number }> {
    const oldest = this.pending.reduce<number | null>((m, p) => {
      const t = Date.parse(p.job.enqueuedAt);
      return m === null ? t : Math.min(m, t);
    }, null);
    return {
      depth: this.pending.length,
      inFlight: this.inFlight,
      ...(oldest !== null ? { oldestAgeSec: Math.max(0, Math.round((Date.now() - oldest) / 1000)) } : {}),
    };
  }

  private waitIdle(timeoutMs: number): Promise<void> {
    if (!this.pending.length && !this.inFlight) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.idleWaiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      timer.unref?.();
      this.idleWaiters.add(done);
    });
  }

  /** 切换驱动前排空：停止接收新任务，等到队列为空或超时，返回剩余数量（剩下的会随进程重启丢失） */
  async drain(timeoutSec: number): Promise<{ remaining: number }> {
    this.draining = true;
    if (this.consuming) await this.waitIdle(Math.max(0, timeoutSec) * 1000);
    return { remaining: this.pending.length + this.inFlight };
  }

  async close(): Promise<void> {
    this.draining = true;
    if (this.consuming) await this.waitIdle(5_000);
    this.closed = true;
    this.kick();
  }
}
