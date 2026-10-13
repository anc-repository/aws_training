// backend/src/adapters/analytics/firehose.ts —— AnalyticsPort 的 `firehose` 驱动（Amazon Data Firehose）
// 本轮未实现
// 脚手架桩：方法抛出 NotImplementedError（HTTP 层映射为 501）。由「后续版本（本轮 MVP 不实现；配置该驱动会被 config/implemented.ts 以 CFG-001 拒绝）」填充。
import type { AdapterDeps } from '../types.js';
import type { AdapterMeta, ProbeResult } from '../../ports/common.js';
import type { AnalyticsPort, ClickEvent } from '../../ports/analytics.js';
import { notImplemented } from '../../errors.js';

export class FirehoseAnalytics implements AnalyticsPort {
  readonly meta: AdapterMeta = { module: 'analytics', driver: 'firehose', awsService: 'Amazon Data Firehose', authoritative: false };

  constructor(protected readonly deps: AdapterDeps) {}

  async probe(_opts?: { deep?: boolean }): Promise<ProbeResult> {
    throw notImplemented('FirehoseAnalytics', 'probe', 'analytics');
  }

  async track(_events: ClickEvent[]): Promise<{ accepted: number; dropped: number }> {
    throw notImplemented('FirehoseAnalytics', 'track', 'analytics');
  }

  async report(_q: { from: string; to: string; groupBy: 'type' | 'day' | 'photo' }): Promise<{ mode: 'sync'; rows: Array<Record<string, string | number>> } | { mode: 'async'; queryId: string }> {
    throw notImplemented('FirehoseAnalytics', 'report', 'analytics');
  }

  async reportResult(_queryId: string): Promise<{ state: 'running' | 'succeeded' | 'failed'; rows?: Array<Record<string, string | number>> }> {
    throw notImplemented('FirehoseAnalytics', 'reportResult', 'analytics');
  }
}
