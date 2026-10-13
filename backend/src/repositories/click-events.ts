// backend/src/repositories/click-events.ts —— AnalyticsPort(db) 的 SQL：click_events（03#analytics 第 1 节）
//
// - 批量写入：event_id 唯一，INSERT … ON CONFLICT (event_id) DO NOTHING（重复事件静默丢弃，报表天然去重）；
// - 报表：按 type / day / photo 分组，COUNT(*) 为 PV，COUNT(DISTINCT session_id) 为 UV；
// - 保留期：analytics.retention 分批删除（每批一个短事务）。
import type { Knex } from 'knex';
import { countOf } from '../db/dialect.js';
import type { ClickEvent } from '../ports/analytics.js';

type Row = Record<string, unknown>;

export async function insertEvents(db: Knex, events: readonly ClickEvent[]): Promise<number> {
  if (!events.length) return 0;
  const rows = events.map((e) => ({
    event_id: e.eventId.slice(0, 64), ts: e.ts, session_id: e.sessionId.slice(0, 64), user_id: e.userId ?? null,
    type: e.type, path: e.path.slice(0, 512), photo_id: e.photoId ?? null, referrer: e.referrer ? e.referrer.slice(0, 512) : null,
    ua_family: e.uaFamily ? e.uaFamily.slice(0, 64) : null, ip_hash: e.ipHash.slice(0, 64),
  }));
  await db.transaction(async (trx) => {
    for (let i = 0; i < rows.length; i += 50) {
      await trx('click_events').insert(rows.slice(i, i + 50)).onConflict('event_id').ignore();
    }
  });
  return rows.length;
}

export type ReportRow = Record<string, string | number>;

export async function report(db: Knex, q: { from: string; to: string; groupBy: 'type' | 'day' | 'photo'; limit?: number }): Promise<ReportRow[]> {
  const base = db('click_events').where('ts', '>=', q.from).andWhere('ts', '<', q.to);
  const metrics = [db.raw('count(*) as pv'), db.raw('count(distinct session_id) as uv')];
  let rows: Row[];
  if (q.groupBy === 'type') {
    rows = (await base.select('type', ...metrics).groupBy('type').orderBy('type')) as Row[];
  } else if (q.groupBy === 'day') {
    // ts 是 ISO 字符串：前 10 个字符就是 UTC 日期（两种方言都支持 substr）
    rows = (await base.select(db.raw('substr(ts, 1, 10) as day'), ...metrics).groupByRaw('substr(ts, 1, 10)').orderBy('day')) as Row[];
  } else {
    rows = (await base.whereNotNull('photo_id').select('photo_id', ...metrics).groupBy('photo_id')
      .orderBy('pv', 'desc').limit(q.limit ?? 50)) as Row[];
  }
  return rows.map((r) => {
    const out: ReportRow = {};
    for (const [k, v] of Object.entries(r)) out[k] = typeof v === 'number' || typeof v === 'string' ? (k === 'pv' || k === 'uv' ? Number(v) : v) : String(v);
    return out;
  });
}

export async function countEvents(db: Knex, opts: { since?: string } = {}): Promise<number> {
  const q = db('click_events');
  if (opts.since) q.where('ts', '>=', opts.since);
  return countOf(await q.count({ count: '*' }).first());
}

export async function activeSessionsBetween(db: Knex, from: string, to: string): Promise<{ events: number; sessions: number; users: string[] }> {
  const events = countOf(await db('click_events').where('ts', '>=', from).andWhere('ts', '<', to).count({ count: '*' }).first());
  const sessions = countOf(await db('click_events').where('ts', '>=', from).andWhere('ts', '<', to).countDistinct({ count: 'session_id' }).first());
  const users = ((await db('click_events').distinct('user_id').where('ts', '>=', from).andWhere('ts', '<', to).whereNotNull('user_id')) as Row[])
    .map((r) => String(r.user_id));
  return { events, sessions, users };
}

/** 分批删除早于 cutoff 的事件；返回删除行数 */
export async function purgeEventsBefore(db: Knex, cutoffIso: string, batch = 2000, maxBatches = 500): Promise<number> {
  let total = 0;
  for (let i = 0; i < maxBatches; i++) {
    const ids = ((await db('click_events').select('event_id').where('ts', '<', cutoffIso).orderBy('ts', 'asc').limit(batch)) as Row[])
      .map((r) => String(r.event_id));
    if (!ids.length) break;
    total += await db('click_events').whereIn('event_id', ids).del();
    if (ids.length < batch) break;
  }
  return total;
}
