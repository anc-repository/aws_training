// backend/src/adapters/tagging/none.ts —— TaggerPort 的 `none` 驱动（本地实现）
// 基础属性标签（方向、主色、分辨率档、EXIF），审核恒为 pass
// 脚手架桩：方法抛出 NotImplementedError（HTTP 层映射为 501）。由「L0 本地实现者」填充。
import type { AdapterDeps } from '../types.js';
import type { AdapterMeta, ProbeResult } from '../../ports/common.js';
import type { ImageMeta } from '../../ports/image-processor.js';
import type { TagResult, TaggerPort } from '../../ports/tagger.js';
import { notImplemented } from '../../errors.js';

export class NoTagger implements TaggerPort {
  readonly meta: AdapterMeta = { module: 'tagging', driver: 'none', awsService: null, authoritative: false };

  constructor(protected readonly deps: AdapterDeps) {}

  async probe(_opts?: { deep?: boolean }): Promise<ProbeResult> {
    throw notImplemented('NoTagger', 'probe', 'tagging');
  }

  async analyze(_input: { photoId: string; storageKey: string; meta: ImageMeta; bytes: () => Promise<Buffer> }): Promise<TagResult> {
    throw notImplemented('NoTagger', 'analyze', 'tagging');
  }
}
