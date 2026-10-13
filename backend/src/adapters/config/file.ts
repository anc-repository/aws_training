// backend/src/adapters/config/file.ts —— ConfigPort 的 `file` 驱动（本地实现）
// CLOUDALBUM_ENV_DIR/runtime.json + 目录监听热加载；未知键忽略并报告 CFG-009
// 脚手架桩：方法抛出 NotImplementedError（HTTP 层映射为 501）。由「L0 本地实现者」填充。
import type { AdapterDeps } from '../types.js';
import type { AdapterMeta, ProbeResult } from '../../ports/common.js';
import type { ConfigPort, RuntimeConfig } from '../../ports/config.js';
import { notImplemented } from '../../errors.js';

export class FileConfig implements ConfigPort {
  readonly meta: AdapterMeta = { module: 'config', driver: 'file', awsService: null, authoritative: false };

  constructor(protected readonly deps: AdapterDeps) {}

  async probe(_opts?: { deep?: boolean }): Promise<ProbeResult> {
    throw notImplemented('FileConfig', 'probe', 'config');
  }

  current(): RuntimeConfig {
    throw notImplemented('FileConfig', 'current', 'config');
  }

  onChange(_cb: (next: RuntimeConfig, changedKeys: string[], source: string) => void): () => void {
    throw notImplemented('FileConfig', 'onChange', 'config');
  }

  async refresh(): Promise<{ changedKeys: string[] }> {
    throw notImplemented('FileConfig', 'refresh', 'config');
  }

  describeSource(): { driver: 'file' | 'ssm'; location: string; lastLoadedAt: string; version?: string } {
    throw notImplemented('FileConfig', 'describeSource', 'config');
  }
}
