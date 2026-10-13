// backend/src/adapters/monitoring/cloudwatch.ts —— MetricsPort 的 `cloudwatch` 驱动（Amazon CloudWatch）
// 本轮未实现
// 脚手架桩：方法抛出 NotImplementedError（HTTP 层映射为 501）。由「后续版本（本轮 MVP 不实现；配置该驱动会被 config/implemented.ts 以 CFG-001 拒绝）」填充。
import type { AdapterDeps } from '../types.js';
import type { AdapterMeta, ProbeResult } from '../../ports/common.js';
import type { Dims, MetricsPort } from '../../ports/metrics.js';
import { notImplemented } from '../../errors.js';

export class CwMetrics implements MetricsPort {
  readonly meta: AdapterMeta = { module: 'monitoring', driver: 'cloudwatch', awsService: 'Amazon CloudWatch', authoritative: false };

  constructor(protected readonly deps: AdapterDeps) {}

  async probe(_opts?: { deep?: boolean }): Promise<ProbeResult> {
    throw notImplemented('CwMetrics', 'probe', 'monitoring');
  }

  counter(_name: string, _value?: number, _dims?: Dims): void {
    throw notImplemented('CwMetrics', 'counter', 'monitoring');
  }

  histogram(_name: string, _value: number, _unit: 'ms' | 'bytes' | 'count', _dims?: Dims): void {
    throw notImplemented('CwMetrics', 'histogram', 'monitoring');
  }

  gauge(_name: string, _value: number, _dims?: Dims): void {
    throw notImplemented('CwMetrics', 'gauge', 'monitoring');
  }

  async flush(): Promise<void> {
    throw notImplemented('CwMetrics', 'flush', 'monitoring');
  }
}
