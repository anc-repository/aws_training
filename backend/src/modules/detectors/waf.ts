// backend/src/modules/detectors/waf.ts —— waf 感知器（总纲 3.3；01#waf 第 10 节）
//
// 桩（wave1-prep）：由 waf 的实现者填充。约定：
//   - 构造函数不做 I/O；observe() 只做 O(1) 计数（禁止 I/O）；detect() 读 IMDS / 本机 / 控制面只读 API，
//     控制面调用经 deps.aws（adapters/aws/clients.ts）并用 withAwsRetry() 包一层（超时与重试，2026-10-14 实机验证的教训）；
//     瞬时失败返回 { status: 'degraded', transient: true }，不要因为一次超时就报 error。
//   - 无凭证（IAM_CREDENTIALS=none）时降为 observed / inferred（CRED-004），不报 error。
//   - 被动：经 CloudFront / ALB 入口的请求中带 x-amzn-waf-cloudalbum 的比例；深度：wafv2:GetWebACL / GetIPSet（CLOUDFRONT 范围在 us-east-1）。DEP-018 的条件在 rules.ts。
import type { ProbeResult } from '../../ports/common.js';
import { notImplemented } from '../../errors.js';
import type { Detector, DetectorContext, DetectorFactory } from './types.js';

export class WafDetector implements Detector {
  readonly module = 'waf' as const;

  constructor(protected readonly ctx: DetectorContext) {}

  async detect(_opts: { deep?: boolean }): Promise<ProbeResult> {
    throw notImplemented('WafDetector', 'detect', 'waf');
  }
}

export const wafDetector: DetectorFactory = { module: 'waf', create: (ctx) => new WafDetector(ctx) };
