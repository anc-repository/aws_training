// backend/src/adapters/tagging/rekognition.ts —— TaggerPort 的 `rekognition` 驱动（Amazon Rekognition）
// 本轮未实现
// 脚手架桩：方法抛出 NotImplementedError（HTTP 层映射为 501）。由「后续版本（本轮 MVP 不实现；配置该驱动会被 config/implemented.ts 以 CFG-001 拒绝）」填充。
import type { AdapterDeps } from '../types.js';
import type { AdapterMeta, ProbeResult } from '../../ports/common.js';
import type { ImageMeta } from '../../ports/image-processor.js';
import type { TagResult, TaggerPort } from '../../ports/tagger.js';
import { notImplemented } from '../../errors.js';

export class RekognitionTagger implements TaggerPort {
  readonly meta: AdapterMeta = { module: 'tagging', driver: 'rekognition', awsService: 'Amazon Rekognition', authoritative: false };

  constructor(protected readonly deps: AdapterDeps) {}

  async probe(_opts?: { deep?: boolean }): Promise<ProbeResult> {
    throw notImplemented('RekognitionTagger', 'probe', 'tagging');
  }

  async analyze(_input: { photoId: string; storageKey: string; meta: ImageMeta; bytes: () => Promise<Buffer> }): Promise<TagResult> {
    throw notImplemented('RekognitionTagger', 'analyze', 'tagging');
  }
}
