// backend/src/adapters/image-processing/lambda.ts —— ImageProcessorPort 的 `lambda` 驱动（AWS Lambda）
// S3 → EventBridge → Lambda；HMAC 回调或结果队列写回；对账
// 脚手架桩：方法抛出 NotImplementedError（HTTP 层映射为 501）。由「image-processing 模块实现者」填充。
import type { AdapterDeps } from '../types.js';
import type { AdapterMeta, ProbeResult } from '../../ports/common.js';
import type { ImageFailure, ImageJob, ImageProcessorPort, ImageResult } from '../../ports/image-processor.js';
import { notImplemented } from '../../errors.js';

export class LambdaImageProcessor implements ImageProcessorPort {
  readonly meta: AdapterMeta = { module: 'image-processing', driver: 'lambda', awsService: 'AWS Lambda', authoritative: true };
  readonly placement = 'lambda' as const;

  constructor(protected readonly deps: AdapterDeps) {}

  async probe(_opts?: { deep?: boolean }): Promise<ProbeResult> {
    throw notImplemented('LambdaImageProcessor', 'probe', 'image-processing');
  }

  async submit(_job: ImageJob): Promise<{ mode: 'sync'; result: ImageResult } | { mode: 'async'; expectedBy: string }> {
    throw notImplemented('LambdaImageProcessor', 'submit', 'image-processing');
  }

  async reconcile(_stuckBefore: Date): Promise<{ resubmitted: number; failed: number }> {
    throw notImplemented('LambdaImageProcessor', 'reconcile', 'image-processing');
  }

  async acceptCallback(_rawBody: Buffer, _headers: { signature: string; timestamp: string }): Promise<ImageResult | ImageFailure> {
    throw notImplemented('LambdaImageProcessor', 'acceptCallback', 'image-processing');
  }

  async acceptResult(_message: unknown): Promise<ImageResult | ImageFailure> {
    throw notImplemented('LambdaImageProcessor', 'acceptResult', 'image-processing');
  }
}
