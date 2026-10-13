// backend/src/adapters/analytics/db.ts —— AnalyticsPort 的 `db` 驱动（本地实现，L0 默认）
//
// - 进程内缓冲：攒够 ANALYTICS_BUFFER_MAX 条或每 ANALYTICS_FLUSH_MS 毫秒，在一个事务里批量
//   INSERT INTO click_events … ON CONFLICT (event_id) DO NOTHING（repositories/click-events.ts）；
// - 缓冲上限 10 × ANALYTICS_BUFFER_MAX，溢出丢弃并计数；写库失败也丢弃并计数（非权威端口：不阻塞请求，探针 degraded）；
// - 管理员 X-Compare-Bypass: analytics 时本次请求不上报（路径头 analytics=db:bypass）；
// - 报表：同步 SQL（{ mode: 'sync', rows }）。
import type { AdapterDeps } from '../types.js';
import type { AdapterMeta, ProbeResult } from '../../ports/common.js';
import type { AnalyticsPort, ClickEvent } from '../../ports/analytics.js';
import { isBypassed, markPath } from '../../observability/request-context.js';
import { insertEvents, report as reportSql } from '../../repositories/click-events.js';

const EVENT_TYPES: ReadonlySet<ClickEvent['type']> = new Set(['page_view', 'photo_view', 'like', 'comment', 'share_open', 'upload']);

export function isValidClickEvent(e: unknown): e is ClickEvent {
  const x = e as Partial<ClickEvent>;
  return Boolean(x) && typeof x.eventId === 'string' && x.eventId.length > 0 && x.eventId.length <= 64
    && typeof x.ts === 'string' && !Number.isNaN(Date.parse(x.ts))
    && typeof x.sessionId === 'string' && x.sessionId.length > 0
    && typeof x.type === 'string' && EVENT_TYPES.has(x.type as ClickEvent['type'])
    && typeof x.path === 'string' && typeof x.ipHash === 'string';
}

export class DbAnalytics implements AnalyticsPort {
  readonly meta: AdapterMeta = { module: 'analytics', driver: 'db', awsService: null, authoritative: false };
  private buffer: ClickEvent[] = [];
  private timer: NodeJS.Timeout | null = null;
  private flushing: Promise<void> | null = null;
  private written = 0;
  private dropped = 0;
  private lastError: { at: number; message: string } | null = null;
  private readonly bufferMax: number;
  private readonly flushMs: number;

  constructor(protected readonly deps: AdapterDeps) {
    this.bufferMax = deps.cfg.analytics.ANALYTICS_BUFFER_MAX;
    this.flushMs = deps.cfg.analytics.ANALYTICS_FLUSH_MS;
  }

  async init(): Promise<void> {
    this.timer = setInterval(() => void this.flush(), this.flushMs);
    this.timer.unref();
  }

  async probe(_opts?: { deep?: boolean }): Promise<ProbeResult> {
    const data = { buffered: this.buffer.length, written: this.written, dropped: this.dropped, lastError: this.lastError?.message ?? null };
    const base = `点击事件批量写入 click_events · 缓冲 ${this.buffer.length} · 已写 ${this.written} · 丢弃 ${this.dropped}`;
    if (this.lastError && Date.now() - this.lastError.at < 5 * 60_000) {
      return { status: 'degraded', detail: `${base} · 最近写库失败：${this.lastError.message}`, data };
    }
    return { status: 'ok', detail: base, data };
  }

  async track(events: ClickEvent[]): Promise<{ accepted: number; dropped: number }> {
    if (isBypassed('analytics')) {
      markPath('analytics', 'db:bypass');
      return { accepted: 0, dropped: 0 };
    }
    const cap = this.bufferMax * 10;
    let accepted = 0;
    let dropped = 0;
    for (const e of events) {
      if (!isValidClickEvent(e) || this.buffer.length >= cap) {
        dropped++;
        continue;
      }
      this.buffer.push(e);
      accepted++;
    }
    this.dropped += dropped;
    if (this.buffer.length >= this.bufferMax) void this.flush();
    return { accepted, dropped };
  }

  /** 把缓冲写入数据库（同一时刻只有一个 flush 在进行）；失败丢弃并计数 */
  async flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    if (!this.buffer.length || !this.deps.db) return;
    const db = this.deps.db;
    this.flushing = (async () => {
      try {
        while (this.buffer.length) {
          const batch = this.buffer.splice(0, Math.max(this.bufferMax, 1));
          try {
            await insertEvents(db, batch);
            this.written += batch.length;
          } catch (e) {
            this.dropped += batch.length;
            this.lastError = { at: Date.now(), message: (e as Error).message };
            this.deps.logger?.warn('analytics.flush_failed', { error: (e as Error).message, dropped: batch.length });
          }
        }
      } finally {
        this.flushing = null;
      }
    })();
    return this.flushing;
  }

  async report(q: { from: string; to: string; groupBy: 'type' | 'day' | 'photo' }): Promise<{ mode: 'sync'; rows: Array<Record<string, string | number>> } | { mode: 'async'; queryId: string }> {
    if (!this.deps.db) return { mode: 'sync', rows: [] };
    await this.flush();
    return { mode: 'sync', rows: await reportSql(this.deps.dbRead ?? this.deps.db, q) };
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.flush().catch(() => undefined);
  }
}
