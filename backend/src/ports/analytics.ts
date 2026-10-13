// backend/src/ports/analytics.ts （总纲 §4.2，照录）
import type { Adapter } from './common.js';

export interface ClickEvent {
  eventId: string;                   // 去重键：db 驱动唯一索引 ON CONFLICT DO NOTHING；firehose 至少一次投递，报表按它去重
  ts: string; sessionId: string; userId?: string;
  type: 'page_view' | 'photo_view' | 'like' | 'comment' | 'share_open' | 'upload';
  path: string; photoId?: string; referrer?: string; uaFamily?: string; ipHash: string;   // 不存原始 IP
}
type Row = Record<string, string | number>;
export interface AnalyticsPort extends Adapter {
  track(events: ClickEvent[]): Promise<{ accepted: number; dropped: number }>;   // 非权威：失败丢弃并计数
  /** db：同步 SQL；firehose：提交 Athena 查询，返回 queryId（数据落地有缓冲延迟，以官方文档为准） */
  report(q: { from: string; to: string; groupBy: 'type' | 'day' | 'photo' }):
    Promise<{ mode: 'sync'; rows: Row[] } | { mode: 'async'; queryId: string }>;
  reportResult?(queryId: string): Promise<{ state: 'running' | 'succeeded' | 'failed'; rows?: Row[] }>;
}
