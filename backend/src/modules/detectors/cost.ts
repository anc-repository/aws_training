// backend/src/modules/detectors/cost.ts —— cost 感知器（总纲 3.3；06#cost 第 10 节）
//
// 桩（wave1-prep）：由 cost 的实现者填充。约定：
//   - 构造函数不做 I/O；observe() 只做 O(1) 计数（禁止 I/O）；detect() 读 IMDS / 本机 / 控制面只读 API，
//     控制面调用经 deps.aws（adapters/aws/clients.ts）并用 withAwsRetry() 包一层（超时与重试，2026-10-14 实机验证的教训）；
//     瞬时失败返回 { status: 'degraded', transient: true }，不要因为一次超时就报 error。
//   - 无凭证（IAM_CREDENTIALS=none）时降为 observed / inferred（CRED-004），不报 error。
//   - local：按 registry billing × 模块启用时长列出计费资源（不写单价，D14）；budgets：budgets:DescribeBudgets（us-east-1）；Cost Explorer 只在手动刷新时调用（COST_CE_QUERY=manual，按请求计费）。
import type { ProbeResult } from '../../ports/common.js';
import { notImplemented } from '../../errors.js';
import type { Detector, DetectorContext, DetectorFactory } from './types.js';

export class CostDetector implements Detector {
  readonly module = 'cost' as const;

  constructor(protected readonly ctx: DetectorContext) {}

  async detect(_opts: { deep?: boolean }): Promise<ProbeResult> {
    throw notImplemented('CostDetector', 'detect', 'cost');
  }
}

export const costDetector: DetectorFactory = { module: 'cost', create: (ctx) => new CostDetector(ctx) };
