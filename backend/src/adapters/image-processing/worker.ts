// backend/src/adapters/image-processing/worker.ts —— ImageProcessorPort 的 `worker` 驱动（本地档）
//
// submit() 只入队 queue.enqueue('image.process', job, { dedupKey })，接口立即返回 { mode: 'async' }（202）；
// 由谁执行取决于 QUEUE_DRIVER：memory → api 进程内后台执行；sqs → cloudalbum-worker 消费（DEP-004 拒绝 sync）。
// 执行时（jobs/image-process.ts）调用本适配器的 process()：与 inline 共用 renderAndStore()，并发 IMAGE_WORKER_CONCURRENCY。
import type { AdapterDeps } from '../types.js';
import { need } from '../types.js';
import type { AdapterMeta, ProbeResult } from '../../ports/common.js';
import type { ImageJob, ImageProcessorPort, ImageResult } from '../../ports/image-processor.js';
import { getPhoto } from '../../repositories/photos.js';
import { reconcileLocal } from '../../services/photo-pipeline.js';
import { localImageProbe, renderAndStore, Semaphore, type LocalImageProcessor } from './inline.js';

export class WorkerImageProcessor implements ImageProcessorPort, LocalImageProcessor {
  readonly meta: AdapterMeta = { module: 'image-processing', driver: 'worker', awsService: null, authoritative: true };
  readonly placement = 'worker' as const;
  private readonly semaphore: Semaphore;
  private readonly concurrency: number;

  constructor(protected readonly deps: AdapterDeps) {
    const img = deps.cfg.image;
    this.concurrency = img.IMAGE_PROCESSOR === 'worker' ? img.IMAGE_WORKER_CONCURRENCY : 1;
    this.semaphore = new Semaphore(this.concurrency);
  }

  async probe(opts?: { deep?: boolean }): Promise<ProbeResult> {
    const queue = this.deps.queue;
    let backlog: Record<string, unknown> = {};
    let consumer = '';
    if (queue) {
      const s = await queue.stats().catch(() => null);
      if (s) backlog = { depth: s.depth, inFlight: s.inFlight, ...(s.oldestAgeSec !== undefined ? { oldestAgeSec: s.oldestAgeSec } : {}) };
      consumer = queue.semantics.consumer === 'worker' ? '由 cloudalbum-worker 经 SQS 消费' : '由 api 进程内存队列消费';
    }
    return localImageProbe(this.deps, `入队 image.process → ${consumer}（并发 ${this.concurrency}）`, {
      ...(opts?.deep ? { deep: true } : {}), extra: { ...backlog, concurrency: this.concurrency },
    });
  }

  async process(job: ImageJob): Promise<ImageResult> {
    const release = await this.semaphore.acquire();
    try {
      return await renderAndStore(this.deps, job, 'worker');
    } finally {
      release();
    }
  }

  async submit(job: ImageJob): Promise<{ mode: 'sync'; result: ImageResult } | { mode: 'async'; expectedBy: string }> {
    const queue = need(this.deps, 'queue', 'image-processing(worker)');
    // 幂等键带上处理次数：对账重新提交时不会被 processed_jobs 当成“已处理”
    const attempts = this.deps.db ? ((await getPhoto(this.deps.db, job.photoId))?.processingAttempts ?? 0) : 0;
    await queue.enqueue('image.process', job, { dedupKey: `image.process:${job.photoId}:${attempts}` });
    const expectedBy = new Date(Date.now() + this.deps.cfg.image.IMAGE_STUCK_AFTER_SEC * 1000).toISOString();
    return { mode: 'async', expectedBy };
  }

  async reconcile(stuckBefore: Date): Promise<{ resubmitted: number; failed: number }> {
    return reconcileLocal(this.deps, stuckBefore, (job) => this.submit(job));
  }
}
