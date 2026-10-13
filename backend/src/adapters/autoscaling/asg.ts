// backend/src/adapters/autoscaling/asg.ts —— InstanceLifecyclePort 的 `asg` 驱动（Amazon EC2 Auto Scaling）
// 本轮未实现
// 脚手架桩：方法抛出 NotImplementedError（HTTP 层映射为 501）。由「后续版本（本轮 MVP 不实现；配置该驱动会被 config/implemented.ts 以 CFG-001 拒绝）」填充。
import type { AdapterDeps } from '../types.js';
import type { AdapterMeta, ProbeResult } from '../../ports/common.js';
import type { InstanceLifecyclePort } from '../../ports/instance-lifecycle.js';
import { notImplemented } from '../../errors.js';

export class AsgInstance implements InstanceLifecyclePort {
  readonly meta: AdapterMeta = { module: 'autoscaling', driver: 'asg', awsService: 'Amazon EC2 Auto Scaling', authoritative: false };

  constructor(protected readonly deps: AdapterDeps) {}

  async probe(_opts?: { deep?: boolean }): Promise<ProbeResult> {
    throw notImplemented('AsgInstance', 'probe', 'autoscaling');
  }

  async identity(): Promise<{ instanceId: string; az: string; asgName?: string }> {
    throw notImplemented('AsgInstance', 'identity', 'autoscaling');
  }

  onTerminating(_cb: (deadline: Date) => Promise<void>): void {
    throw notImplemented('AsgInstance', 'onTerminating', 'autoscaling');
  }

  async complete(_action: 'CONTINUE' | 'ABANDON'): Promise<void> {
    throw notImplemented('AsgInstance', 'complete', 'autoscaling');
  }
}
