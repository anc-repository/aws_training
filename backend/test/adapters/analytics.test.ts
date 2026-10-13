// AnalyticsPort 契约测试：db 驱动。缓冲批量写入、去重、溢出丢弃、旁路、同步报表
import type { Knex } from 'knex';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DbAnalytics, isValidClickEvent } from '../../src/adapters/analytics/db.js';
import { createRequestContext, runWithContext } from '../../src/observability/request-context.js';
import type { AnalyticsPort, ClickEvent } from '../../src/ports/analytics.js';
import { countEvents, purgeEventsBefore } from '../../src/repositories/click-events.js';
import { adapterDeps, testConfig, testDb } from '../helpers/media-fixtures.js';

let db: Knex;
beforeEach(async () => {
  db = await testDb();
});
afterEach(async () => {
  await db.destroy();
});

function ev(i: number, over: Partial<ClickEvent> = {}): ClickEvent {
  return {
    eventId: `evt-${String(i).padStart(6, '0')}`, ts: `2026-10-12T0${i % 10}:00:00.000Z`, sessionId: `sess-${i % 3}`,
    type: i % 2 ? 'photo_view' : 'page_view', path: '/feed', ipHash: 'h', ...over,
  };
}

/** 所有 AnalyticsPort 驱动共有的行为 */
export function analyticsContract(name: string, make: (db: Knex) => AnalyticsPort & { flush?: () => Promise<void> }): void {
  describe(`AnalyticsPort 契约：${name}`, () => {
    it('track 返回 accepted / dropped；非法事件被丢弃', async () => {
      const a = make(db);
      const r = await a.track([ev(1), ev(2), { ...ev(3), type: 'bogus' as ClickEvent['type'] }]);
      expect(r).toEqual({ accepted: 2, dropped: 1 });
      await a.close?.();
    });

    it('X-Compare-Bypass: analytics 时本次请求不上报', async () => {
      const a = make(db);
      const ctx = createRequestContext();
      ctx.bypass.add('analytics');
      const r = await runWithContext(ctx, () => a.track([ev(1)]));
      expect(r).toEqual({ accepted: 0, dropped: 0 });
      expect(ctx.path.get('analytics')).toMatch(/:bypass$/);
      await a.close?.();
    });
  });
}

const cfg = testConfig({ ANALYTICS_BUFFER_MAX: '3', ANALYTICS_FLUSH_MS: '100000' });
analyticsContract('db', (d) => new DbAnalytics(adapterDeps(cfg, { db: d })));

describe('DbAnalytics', () => {
  it('缓冲达到 ANALYTICS_BUFFER_MAX 时批量写入；event_id 重复静默去重；close 写出剩余', async () => {
    const a = new DbAnalytics(adapterDeps(cfg, { db }));
    await a.init();
    await a.track([ev(1), ev(2)]);
    expect(await countEvents(db)).toBe(0);
    await a.track([ev(3)]);                   // 达到 3 条：触发 flush
    await a.flush();
    expect(await countEvents(db)).toBe(3);
    await a.track([ev(1), ev(4)]);            // ev(1) 重复
    await a.close();
    expect(await countEvents(db)).toBe(4);
  });

  it('缓冲上限 10 × ANALYTICS_BUFFER_MAX，溢出丢弃并计数', async () => {
    const a = new DbAnalytics(adapterDeps(testConfig({ ANALYTICS_BUFFER_MAX: '1000', ANALYTICS_FLUSH_MS: '100000' }), { db: undefined }));
    const r = await a.track(Array.from({ length: 10_005 }, (_, i) => ev(i)));
    expect(r.dropped).toBe(5);
    expect((await a.probe()).data?.dropped).toBe(5);
  });

  it('报表：按 type / day / photo 分组的 PV 与 UV（同步）', async () => {
    const a = new DbAnalytics(adapterDeps(cfg, { db }));
    await a.track([ev(1), ev(2), ev(3, { photoId: 'p1' }), ev(5, { photoId: 'p1', ts: '2026-10-13T01:00:00.000Z' })]);
    const byType = await a.report({ from: '2026-10-01T00:00:00Z', to: '2026-10-31T00:00:00Z', groupBy: 'type' });
    expect(byType.mode).toBe('sync');
    const rows = (byType as { rows: Array<Record<string, string | number>> }).rows;
    expect(rows.find((r) => r.type === 'photo_view')).toMatchObject({ pv: 3 });
    const byDay = await a.report({ from: '2026-10-01T00:00:00Z', to: '2026-10-31T00:00:00Z', groupBy: 'day' });
    expect((byDay as { rows: Array<Record<string, string | number>> }).rows.map((r) => r.day)).toEqual(['2026-10-12', '2026-10-13']);
    const byPhoto = await a.report({ from: '2026-10-01T00:00:00Z', to: '2026-10-31T00:00:00Z', groupBy: 'photo' });
    expect((byPhoto as { rows: Array<Record<string, string | number>> }).rows).toEqual([{ photo_id: 'p1', pv: 2, uv: 2 }]);
    expect(await purgeEventsBefore(db, '2026-10-13T00:00:00Z', 1)).toBe(3);
    expect(await countEvents(db)).toBe(1);
  });

  it('isValidClickEvent', () => {
    expect(isValidClickEvent(ev(1))).toBe(true);
    expect(isValidClickEvent({ ...ev(1), ts: 'not-a-date' })).toBe(false);
    expect(isValidClickEvent(null)).toBe(false);
  });
});
