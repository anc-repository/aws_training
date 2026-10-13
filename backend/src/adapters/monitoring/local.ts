// backend/src/adapters/monitoring/local.ts —— MetricsPort 的 `local` 驱动（本地实现）
// 写入 LabMetricsStore（deps.labMetrics）
// 脚手架桩：方法抛出 NotImplementedError（HTTP 层映射为 501）。由「L0 本地实现者」填充。
import type { AdapterDeps } from '../types.js';
import type { AdapterMeta, ProbeResult } from '../../ports/common.js';
import type { Dims, MetricsPort } from '../../ports/metrics.js';
import { notImplemented } from '../../errors.js';

export class LocalMetrics implements MetricsPort {
  readonly meta: AdapterMeta = { module: 'monitoring', driver: 'local', awsService: null, authoritative: false };

  constructor(protected readonly deps: AdapterDeps) {}

  async probe(_opts?: { deep?: boolean }): Promise<ProbeResult> {
    throw notImplemented('LocalMetrics', 'probe', 'monitoring');
  }

  counter(_name: string, _value?: number, _dims?: Dims): void {
    throw notImplemented('LocalMetrics', 'counter', 'monitoring');
  }

  histogram(_name: string, _value: number, _unit: 'ms' | 'bytes' | 'count', _dims?: Dims): void {
    throw notImplemented('LocalMetrics', 'histogram', 'monitoring');
  }

  gauge(_name: string, _value: number, _dims?: Dims): void {
    throw notImplemented('LocalMetrics', 'gauge', 'monitoring');
  }

  async flush(): Promise<void> {
    throw notImplemented('LocalMetrics', 'flush', 'monitoring');
  }
}
