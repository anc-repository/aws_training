// backend/src/modules/detectors/shell-access.ts —— shell-access 感知器（总纲 3.3；05#shell-access 第 10 节）
//
// 桩（wave1-prep）：由 shell-access 的实现者填充。约定：
//   - 构造函数不做 I/O；observe() 只做 O(1) 计数（禁止 I/O）；detect() 读 IMDS / 本机 / 控制面只读 API，
//     控制面调用经 deps.aws（adapters/aws/clients.ts）并用 withAwsRetry() 包一层（超时与重试，2026-10-14 实机验证的教训）；
//     瞬时失败返回 { status: 'degraded', transient: true }，不要因为一次超时就报 error。
//   - 无凭证（IAM_CREDENTIALS=none）时降为 observed / inferred（CRED-004），不报 error。
//   - 读 security/snapshot.json 的 sshd 统计；ssm 档：ssm:DescribeInstanceInformation（PingStatus）与安全组 22 端口入站（ec2:DescribeSecurityGroups）。observations() 的键 port22Open 是 SEC-003 的输入（rules.ts 约定）。
import type { ProbeResult } from '../../ports/common.js';
import { notImplemented } from '../../errors.js';
import type { Detector, DetectorContext, DetectorFactory } from './types.js';

export class ShellAccessDetector implements Detector {
  readonly module = 'shell-access' as const;

  constructor(protected readonly ctx: DetectorContext) {}

  async detect(_opts: { deep?: boolean }): Promise<ProbeResult> {
    throw notImplemented('ShellAccessDetector', 'detect', 'shell-access');
  }

  /** SEC-003 的输入：{ port22Open: boolean }（实现者在 detect() 中更新） */
  observations(): Record<string, unknown> {
    return {};
  }
}

export const shellAccessDetector: DetectorFactory = { module: 'shell-access', create: (ctx) => new ShellAccessDetector(ctx) };
