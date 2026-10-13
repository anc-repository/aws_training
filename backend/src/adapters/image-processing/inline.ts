// backend/src/adapters/image-processing/inline.ts —— ImageProcessorPort 的 `inline` 驱动（本地实现）
// “上传完成”请求内用 @cloudalbum/image-core 渲染（进程内信号量 IMAGE_INLINE_CONCURRENCY）
// 脚手架桩：方法抛出 NotImplementedError（HTTP 层映射为 501）。由「L0 本地实现者（本地档由 image-processing 模块实现者负责）」填充。
import type { AdapterDeps } from '../types.js';
import type { AdapterMeta, ProbeResult } from '../../ports/common.js';
import type { ImageJob, ImageProcessorPort, ImageResult } from '../../ports/image-processor.js';
import { notImplemented } from '../../errors.js';

export class InlineImageProcessor implements ImageProcessorPort {
  readonly meta: AdapterMeta = { module: 'image-processing', driver: 'inline', awsService: null, authoritative: true };
  readonly placement = 'inline' as const;

  constructor(protected readonly deps: AdapterDeps) {}

  async probe(_opts?: { deep?: boolean }): Promise<ProbeResult> {
    throw notImplemented('InlineImageProcessor', 'probe', 'image-processing');
  }

  async submit(_job: ImageJob): Promise<{ mode: 'sync'; result: ImageResult } | { mode: 'async'; expectedBy: string }> {
    throw notImplemented('InlineImageProcessor', 'submit', 'image-processing');
  }

  async reconcile(_stuckBefore: Date): Promise<{ resubmitted: number; failed: number }> {
    throw notImplemented('InlineImageProcessor', 'reconcile', 'image-processing');
  }
}
