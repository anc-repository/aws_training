// backend/src/adapters/image-processing/worker.ts —— ImageProcessorPort 的 `worker` 驱动（本地实现）
// 本地档：queue.enqueue("image.process")，由 api（memory）或 worker（sqs）消费
// 脚手架桩：方法抛出 NotImplementedError（HTTP 层映射为 501）。由「image-processing 模块实现者（本地档）」填充。
import type { AdapterDeps } from '../types.js';
import type { AdapterMeta, ProbeResult } from '../../ports/common.js';
import type { ImageJob, ImageProcessorPort, ImageResult } from '../../ports/image-processor.js';
import { notImplemented } from '../../errors.js';

export class WorkerImageProcessor implements ImageProcessorPort {
  readonly meta: AdapterMeta = { module: 'image-processing', driver: 'worker', awsService: null, authoritative: true };
  readonly placement = 'worker' as const;

  constructor(protected readonly deps: AdapterDeps) {}

  async probe(_opts?: { deep?: boolean }): Promise<ProbeResult> {
    throw notImplemented('WorkerImageProcessor', 'probe', 'image-processing');
  }

  async submit(_job: ImageJob): Promise<{ mode: 'sync'; result: ImageResult } | { mode: 'async'; expectedBy: string }> {
    throw notImplemented('WorkerImageProcessor', 'submit', 'image-processing');
  }

  async reconcile(_stuckBefore: Date): Promise<{ resubmitted: number; failed: number }> {
    throw notImplemented('WorkerImageProcessor', 'reconcile', 'image-processing');
  }
}
