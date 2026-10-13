// backend/src/ports/metrics.ts （总纲 §4.2，照录）
import type { Adapter } from './common.js';

export type Dims = Partial<Record<'route' | 'module' | 'driver' | 'outcome' | 'job', string>>;  // 维度白名单，防止高基数
export interface MetricsPort extends Adapter {
  counter(name: string, value?: number, dims?: Dims): void;
  histogram(name: string, value: number, unit: 'ms' | 'bytes' | 'count', dims?: Dims): void;
  gauge(name: string, value: number, dims?: Dims): void;
  flush(): Promise<void>;
}
// local 档写入 LabMetricsStore（见 7.3）；cloudwatch 档 = local + 批量 PutMetricData（Values/Counts 上报原始分布以支持百分位；EMF 为可选模式）。
// LabMetricsStore 永远开启，不受 METRICS_DRIVER 影响——没有 CloudWatch 也能做对比。
// 只读侧 MetricsReader（/api/lab/metrics、/api/lab/monitoring/alarms）：local 读 LabMetricsStore，cloudwatch 读 GetMetricData。
