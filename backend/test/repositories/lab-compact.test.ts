// repositories/lab.ts 的 compactRollups（lab.compact 定时任务）：分钟级汇总 → 小时级
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Knex } from 'knex';
import { jsonIn } from '../../src/db/dialect.js';
import { compactRollups, insertRollups } from '../../src/repositories/lab.js';
import { testDb } from '../helpers/media-fixtures.js';

let db: Knex;

beforeAll(async () => {
  db = await testDb();
});

afterAll(async () => {
  await db?.destroy();
});

const row = (minute: string, extra: Partial<Parameters<typeof insertRollups>[1][number]> = {}) => ({
  minute, instanceId: 'i-1', role: 'api' as const, kind: 'route' as const, route: '/api/feed', method: 'GET',
  count: 2, errors: 1, sumMs: 10, maxMs: 7, hist: [1, 1, 0], ...extra,
});

describe('compactRollups', () => {
  it('同一小时同一维度合并为一行 granularity=hour；截止时间之后的分钟行保留', async () => {
    await insertRollups(db, [
      row('2026-10-01T10:01:00.000Z'),
      row('2026-10-01T10:59:00.000Z', { maxMs: 9, hist: [0, 2, 1] }),
      row('2026-10-01T10:30:00.000Z', { route: '/api/photos/:id' }),
      row('2026-10-01T11:00:00.000Z'),
      row('2026-10-03T10:00:00.000Z'),                                   // 截止时间之后
      row('2026-10-01T10:05:00.000Z', { runId: 'run-1', label: 'after' }),   // 实验行单独成组
    ]);
    const r = await compactRollups(db, new Date('2026-10-02T00:00:00.000Z'), { batchSize: 2 });
    expect(r).toEqual({ minuteRows: 5, hourRows: 4 });
    const hours = await db('lab_metric_rollups').where('granularity', 'hour').orderBy(['minute', 'route', 'run_id']);
    expect(hours).toHaveLength(4);
    const feed10 = hours.find((h) => h.minute === '2026-10-01T10:00:00.000Z' && h.route === '/api/feed' && !h.run_id)!;
    expect(feed10).toMatchObject({ count: 4, errors: 2, sum_ms: 20, max_ms: 9 });
    expect(jsonIn(feed10.hist, [])).toEqual([1, 3, 1]);
    expect(await db('lab_metric_rollups').where('granularity', 'minute').count({ n: '*' })).toEqual([{ n: 1 }]);
    expect(await compactRollups(db, new Date('2026-10-02T00:00:00.000Z'))).toEqual({ minuteRows: 0, hourRows: 0 });
  });
});
