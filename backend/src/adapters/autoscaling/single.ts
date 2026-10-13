// backend/src/adapters/autoscaling/single.ts —— InstanceLifecyclePort 的 `single` 驱动（本地实现，DEPLOY_MODE=single）
// identity()：EC2 上经 IMDSv2 读出实例 ID 与 AZ（X-CloudAlbum-Path 的 inst / az 段）；不在 EC2 上（开发机）时退回主机名、az=local。
// 单实例没有生命周期钩子：onTerminating() 只登记回调（SIGTERM 的优雅停机由 server / worker 处理），complete() 为空操作。
import { hostname } from 'node:os';
import type { AdapterDeps } from '../types.js';
import type { AdapterMeta, ProbeResult } from '../../ports/common.js';
import type { InstanceLifecyclePort } from '../../ports/instance-lifecycle.js';
import { detectEc2Host, ImdsClient, readInstanceFacts } from '../../modules/detectors/ec2.js';

export class SingleInstance implements InstanceLifecyclePort {
  readonly meta: AdapterMeta = { module: 'autoscaling', driver: 'single', awsService: null, authoritative: false };
  private cached?: { instanceId: string; az: string; source: 'imds' | 'hostname' };
  private readonly callbacks: Array<(deadline: Date) => Promise<void>> = [];

  constructor(protected readonly deps: AdapterDeps, private readonly opts: { onEc2?: () => boolean; imds?: ImdsClient } = {}) {}

  private async resolve(): Promise<{ instanceId: string; az: string; source: 'imds' | 'hostname' }> {
    if (this.cached) return this.cached;
    const onEc2 = this.opts.onEc2 ? this.opts.onEc2() : detectEc2Host();
    if (onEc2) {
      const facts = await readInstanceFacts(this.opts.imds ?? new ImdsClient({ timeoutMs: this.deps.cfg.iam.IAM_IMDS_TIMEOUT_MS }));
      if (facts?.instanceId) {
        this.cached = { instanceId: facts.instanceId, az: facts.az ?? 'unknown', source: 'imds' };
        return this.cached;
      }
    }
    this.cached = { instanceId: hostname(), az: 'local', source: 'hostname' };
    return this.cached;
  }

  async probe(_opts?: { deep?: boolean }): Promise<ProbeResult> {
    const id = await this.resolve();
    return {
      status: 'ok',
      detail: `单实例（DEPLOY_MODE=single）· ${id.instanceId}${id.source === 'imds' ? ` · ${id.az}` : '（开发机：主机名）'} · 扩容只能换更大的实例类型`,
      confidence: id.source === 'imds' ? 'confirmed' : 'inferred',
      data: { ...id },
    };
  }

  async identity(): Promise<{ instanceId: string; az: string; asgName?: string }> {
    const { instanceId, az } = await this.resolve();
    return { instanceId, az };
  }

  onTerminating(cb: (deadline: Date) => Promise<void>): void {
    this.callbacks.push(cb);
  }

  async complete(_action: 'CONTINUE' | 'ABANDON'): Promise<void> {
    /* 单实例没有生命周期钩子 */
  }
}
