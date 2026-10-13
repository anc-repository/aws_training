// backend/src/modules/detectors/iam.ts —— iam 感知器（总纲 3.3：IMDS / 本机感知 + sts:GetCallerIdentity、iam:GetRole）
//
// iam 是应用适配器型模块，主探针在 adapters/iam/{role,keys}.ts 的 probe()；本感知器补充“IMDS 中是否有角色、
// 凭证来源与前缀（ASIA / AKIA）”等观测，供 /lab 卡片展示。
// 脚手架桩：detect() 抛出 NotImplementedError。由「iam 模块实现者」填充（不需要时可从 detectors/index.ts 移除）。
import { notImplemented } from '../../errors.js';
import type { ProbeResult } from '../../ports/common.js';
import type { Detector, DetectorContext, DetectorFactory } from './types.js';

export class IamDetector implements Detector {
  readonly module = 'iam' as const;
  constructor(protected readonly ctx: DetectorContext) {}

  async detect(_opts: { deep?: boolean }): Promise<ProbeResult> {
    throw notImplemented('IamDetector', 'detect', 'iam');
  }
}

export const iamDetector: DetectorFactory = { module: 'iam', create: (ctx) => new IamDetector(ctx) };
