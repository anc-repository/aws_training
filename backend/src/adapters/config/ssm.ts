// backend/src/adapters/config/ssm.ts —— ConfigPort 的 `ssm` 驱动（AWS Systems Manager Parameter Store）
// 本轮未实现
// 脚手架桩：方法抛出 NotImplementedError（HTTP 层映射为 501）。由「后续版本（本轮 MVP 不实现；配置该驱动会被 config/implemented.ts 以 CFG-001 拒绝）」填充。
import type { AdapterDeps } from '../types.js';
import type { AdapterMeta, ProbeResult } from '../../ports/common.js';
import type { ConfigPort, RuntimeConfig } from '../../ports/config.js';
import { notImplemented } from '../../errors.js';

export class SsmConfig implements ConfigPort {
  readonly meta: AdapterMeta = { module: 'config', driver: 'ssm', awsService: 'AWS Systems Manager Parameter Store', authoritative: false };

  constructor(protected readonly deps: AdapterDeps) {}

  async probe(_opts?: { deep?: boolean }): Promise<ProbeResult> {
    throw notImplemented('SsmConfig', 'probe', 'config');
  }

  current(): RuntimeConfig {
    throw notImplemented('SsmConfig', 'current', 'config');
  }

  onChange(_cb: (next: RuntimeConfig, changedKeys: string[], source: string) => void): () => void {
    throw notImplemented('SsmConfig', 'onChange', 'config');
  }

  async refresh(): Promise<{ changedKeys: string[] }> {
    throw notImplemented('SsmConfig', 'refresh', 'config');
  }

  describeSource(): { driver: 'file' | 'ssm'; location: string; lastLoadedAt: string; version?: string } {
    throw notImplemented('SsmConfig', 'describeSource', 'config');
  }
}
