// backend/src/services/report.ts —— 每日统计日报（F13，04#scheduler 的 report.daily）
//
// 统计前一天（SCHEDULER_TIMEZONE，默认 Asia/Tokyo 的自然日）的上传数、点赞数、评论数、活跃用户数与访问量，
// 生成 CSV 经 StoragePort 写入 reports/daily/<yyyy-mm-dd>.csv（private：只有管理员能签发读取 URL），
// 然后发布 report.ready（audience=admin：站内信 + notify.fanout，由 NotifierPort 按驱动发邮件 / SNS）。
// 同一天重复生成会覆盖同一个键（幂等）；事件 ID 为 report.daily:<日期>，站内信不会重复。
import type { Knex } from 'knex';
import type { AppConfig } from '../config/schema.js';
import { emitNotification } from '../jobs/notify.js';
import type { Logger } from '../ports/logger.js';
import type { NotifierPort } from '../ports/notifier.js';
import type { QueuePort } from '../ports/queue.js';
import type { StoragePort } from '../ports/storage.js';
import { activeSessionsBetween, report as eventReport } from '../repositories/click-events.js';
import { photoStatsBetween } from '../repositories/photos.js';
import { socialStatsBetween } from '../repositories/social-db.js';

export interface ReportDeps { cfg: AppConfig; db: Knex; storage: StoragePort; queue: QueuePort; notifier?: NotifierPort; logger?: Logger }

export interface DailyStats {
  date: string; timezone: string; from: string; to: string;
  uploads: number; ready: number; failed: number; likes: number; comments: number;
  activeUsers: number; pageViews: number; sessions: number;
}

/** 某时区下的日期（YYYY-MM-DD） */
export function zonedDate(d: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

/** 某时区下 `day` 00:00 对应的 UTC 时刻 */
export function zonedMidnightUtc(day: string, timeZone: string): Date {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const guess = Date.UTC(y, m - 1, d);
  // 该时刻在目标时区显示的墙上时间与 UTC 的差，就是偏移量（两次迭代处理夏令时边界）
  let ts = guess;
  for (let i = 0; i < 2; i++) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone, hour12: false, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
    }).formatToParts(new Date(ts));
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
    const wall = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
    ts = guess - (wall - ts);
  }
  return new Date(ts);
}

export function previousDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}

export function nextDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

export function reportKey(day: string): string {
  return `reports/daily/${day}.csv`;
}

export async function computeDailyStats(deps: Pick<ReportDeps, 'cfg' | 'db'>, day: string): Promise<DailyStats> {
  const tz = deps.cfg.scheduler.SCHEDULER_TIMEZONE;
  const from = zonedMidnightUtc(day, tz).toISOString();
  const to = zonedMidnightUtc(nextDay(day), tz).toISOString();
  const photos = await photoStatsBetween(deps.db, from, to);
  const sessions = await activeSessionsBetween(deps.db, from, to);
  let likes = 0;
  let comments = 0;
  let actors: string[] = [];
  if (deps.cfg.social.SOCIAL_DRIVER === 'db') {
    const s = await socialStatsBetween(deps.db, from, to);
    likes = s.likes;
    comments = s.comments;
    actors = s.actors;
  } else {
    // dynamodb 驱动：社交数据不在关系库，改用点击流中的 like / comment 事件近似
    for (const r of await eventReport(deps.db, { from, to, groupBy: 'type' })) {
      if (r.type === 'like') likes = Number(r.pv);
      if (r.type === 'comment') comments = Number(r.pv);
    }
  }
  const pageViews = (await eventReport(deps.db, { from, to, groupBy: 'type' })).reduce((s, r) => s + (r.type === 'page_view' || r.type === 'photo_view' ? Number(r.pv) : 0), 0);
  const active = new Set([...photos.uploaders, ...actors, ...sessions.users]);
  return {
    date: day, timezone: tz, from, to, uploads: photos.uploads, ready: photos.ready, failed: photos.failed, likes, comments,
    activeUsers: active.size, pageViews, sessions: sessions.sessions,
  };
}

export function toCsv(s: DailyStats): string {
  const rows: Array<[string, string | number]> = [
    ['date', s.date], ['timezone', s.timezone], ['from_utc', s.from], ['to_utc', s.to],
    ['uploads', s.uploads], ['ready', s.ready], ['failed', s.failed], ['likes', s.likes], ['comments', s.comments],
    ['active_users', s.activeUsers], ['page_views', s.pageViews], ['sessions', s.sessions],
  ];
  return `metric,value\n${rows.map(([k, v]) => `${k},${String(v).replace(/[,\n"]/g, ' ')}`).join('\n')}\n`;
}

/** 生成某一天（默认：时区内的“昨天”）的日报并通知管理员 */
export async function generateDailyReport(deps: ReportDeps, opts: { now?: Date; day?: string; notify?: boolean } = {}): Promise<{ day: string; key: string; stats: DailyStats; bytes: number }> {
  const tz = deps.cfg.scheduler.SCHEDULER_TIMEZONE;
  const day = opts.day ?? previousDay(zonedDate(opts.now ?? new Date(), tz));
  const stats = await computeDailyStats(deps, day);
  const csv = Buffer.from(toCsv(stats), 'utf8');
  const key = reportKey(day);
  await deps.storage.putObject(key, csv, { contentType: 'text/csv; charset=utf-8', cacheControl: 'private, max-age=300' });
  if (opts.notify !== false) {
    await emitNotification(deps, {
      eventId: `report.daily:${day}`, type: 'report.ready', audience: 'admin', origin: 'ec2', recipientUserId: '',
      title: `日报 ${day} 已生成`,
      body: `上传 ${stats.uploads} · 点赞 ${stats.likes} · 评论 ${stats.comments} · 活跃用户 ${stats.activeUsers}`,
      link: `/admin/reports/${day}`, data: { day, key },
    });
  }
  deps.logger?.info('report.daily.generated', { day, key, ...stats });
  return { day, key, stats, bytes: csv.length };
}
