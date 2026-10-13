// backend/src/adapters/analytics/db.ts —— AnalyticsPort 的 `db` 驱动（本地实现）
// click_events 表批量写入（ON CONFLICT DO NOTHING）+ SQL 报表
// 脚手架桩：方法抛出 NotImplementedError（HTTP 层映射为 501）。由「L0 本地实现者」填充。
import type { AdapterDeps } from '../types.js';
import type { AdapterMeta, ProbeResult } from '../../ports/common.js';
import type { AnalyticsPort, ClickEvent } from '../../ports/analytics.js';
import { notImplemented } from '../../errors.js';

export class DbAnalytics implements AnalyticsPort {
  readonly meta: AdapterMeta = { module: 'analytics', driver: 'db', awsService: null, authoritative: false };

  constructor(protected readonly deps: AdapterDeps) {}

  async probe(_opts?: { deep?: boolean }): Promise<ProbeResult> {
    throw notImplemented('DbAnalytics', 'probe', 'analytics');
  }

  async track(_events: ClickEvent[]): Promise<{ accepted: number; dropped: number }> {
    throw notImplemented('DbAnalytics', 'track', 'analytics');
  }

  async report(_q: { from: string; to: string; groupBy: 'type' | 'day' | 'photo' }): Promise<{ mode: 'sync'; rows: Array<Record<string, string | number>> } | { mode: 'async'; queryId: string }> {
    throw notImplemented('DbAnalytics', 'report', 'analytics');
  }
}
