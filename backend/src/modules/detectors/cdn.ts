// backend/src/modules/detectors/cdn.ts —— cdn 感知器（总纲 3.3：参数型模块的被动感知，与 CdnPort 的主动探针互补）
//
// 请求头感知：经 8080 监听器进入的请求占比（entry 以 cloudfront> 开头）、X-Origin-Verify 不匹配的回源计数（SEC-001）；
// 控制面感知：cloudfront:GetDistribution 状态（需要凭证，credentials: optional → 无凭证时降为 observed）。
// 脚手架桩：detect() 抛出 NotImplementedError；observe() 为空操作。由「cdn 模块实现者」填充。
import { notImplemented } from '../../errors.js';
import type { ProbeResult } from '../../ports/common.js';
import type { Detector, DetectorContext, DetectorFactory } from './types.js';

export class CdnDetector implements Detector {
  readonly module = 'cdn' as const;
  constructor(protected readonly ctx: DetectorContext) {}

  observe(_req: { headers: import('node:http').IncomingHttpHeaders; remoteAddr: string }): void {
    /* 由 cdn 模块实现者实现：O(1) 计数 */
  }

  async detect(_opts: { deep?: boolean }): Promise<ProbeResult> {
    throw notImplemented('CdnDetector', 'detect', 'cdn');
  }
}

export const cdnDetector: DetectorFactory = { module: 'cdn', create: (ctx) => new CdnDetector(ctx) };
