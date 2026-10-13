// backend/src/adapters/autoscaling/single.ts —— InstanceLifecyclePort 的 `single` 驱动（本地实现）
// IMDSv2 读取实例 ID 与 AZ（X-CloudAlbum-Path 的 inst / az）；开发机上退回主机名
// 脚手架桩：方法抛出 NotImplementedError（HTTP 层映射为 501）。由「L0 本地实现者」填充。
import type { AdapterDeps } from '../types.js';
import type { AdapterMeta, ProbeResult } from '../../ports/common.js';
import type { InstanceLifecyclePort } from '../../ports/instance-lifecycle.js';
import { notImplemented } from '../../errors.js';

export class SingleInstance implements InstanceLifecyclePort {
  readonly meta: AdapterMeta = { module: 'autoscaling', driver: 'single', awsService: null, authoritative: false };

  constructor(protected readonly deps: AdapterDeps) {}

  async probe(_opts?: { deep?: boolean }): Promise<ProbeResult> {
    throw notImplemented('SingleInstance', 'probe', 'autoscaling');
  }

  async identity(): Promise<{ instanceId: string; az: string; asgName?: string }> {
    throw notImplemented('SingleInstance', 'identity', 'autoscaling');
  }

  onTerminating(_cb: (deadline: Date) => Promise<void>): void {
    throw notImplemented('SingleInstance', 'onTerminating', 'autoscaling');
  }

  async complete(_action: 'CONTINUE' | 'ABANDON'): Promise<void> {
    throw notImplemented('SingleInstance', 'complete', 'autoscaling');
  }
}
