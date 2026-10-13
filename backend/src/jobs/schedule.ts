// backend/src/jobs/schedule.ts —— 定时任务注册表（04#scheduler 第 1 节；8 个 ScheduledJobName，时区 SCHEDULER_TIMEZONE）
//
// | 任务                 | 表达式        | singleton | 作用 |
// | report.daily         | 0 9 * * *     | 是 | 前一天的日报 CSV → reports/daily/，发布 report.ready（F13） |
// | share.cleanup        | 0 * * * *     | 是 | 清理过期分享链接（dynamodb 驱动返回 0，交给 TTL） |
// | image.reconcile      | * * * * *     | 是 | PROCESSING 超时的照片补记 / 重新提交 / FAILED；UPLOADING 超过 1 小时的孤儿删除；.incoming 残留清理 |
// | outbox.retention     | 30 3 * * *    | 是 | 删除超过 OUTBOX_RETENTION_DAYS 的 outbox 邮件（.eml 与记录）与 7 天前的 processed_jobs |
// | lab.compact          | 0 4 * * *     | 是 | 把 2 天前的实验指标压缩为小时级（repositories/lab.ts 的 compactRollups，未实现时跳过） |
// | lab.heartbeat        | */5 * * * *   | 否 | 无副作用的对照任务，只写一行 job_runs；仅 SCHEDULER_COMPARE_HEARTBEAT=on 时注册 |
// | analytics.retention  | 15 3 * * *    | 是 | 分批删除超过 ANALYTICS_RETENTION_DAYS 的 click_events（firehose 档立即返回） |
// | audit.retention      | 45 3 * * *    | 是 | 删除超过 AUDIT_RETENTION_DAYS 的 audit_log 行 |
// | atl.probe-nonce-gc   | */10 * * * *  | 是 | ATL 平台模式（06 PM-09）：删除 exp < now - 600 的一次性探测令牌 nonce；只在平台模式下注册 |
//
// eventbridge 档由 CloudFormation 按同一张表创建 Schedule（node dist/cli.js scheduler export 生成参数）。
import path from 'node:path';
import { rm, readdir, unlink } from 'node:fs/promises';
import type { Container } from '../container.js';
import { asLocalMultipart } from '../adapters/storage/local.js';
import type { ScheduledJobDef, ScheduledJobName } from '../ports/scheduler.js';
import { purgeExpiredNonces } from '../repositories/atl-probe-nonces.js';
import { purgeEventsBefore } from '../repositories/click-events.js';
import { platformMode } from '../platform/mode.js';
import { purgeBefore } from '../repositories/job-runs.js';
import { deleteAuditBefore } from '../repositories/audit.js';
import * as labRepo from '../repositories/lab.js';
import { deleteOutboxBefore } from '../repositories/outbox.js';
import { deletePhotoRow, findStaleUploading } from '../repositories/photos.js';
import { generateDailyReport } from '../services/report.js';

export interface ScheduleEntry { name: ScheduledJobName; cron: string; singleton: boolean }

export const SCHEDULE: readonly ScheduleEntry[] = [
  { name: 'report.daily', cron: '0 9 * * *', singleton: true },
  { name: 'share.cleanup', cron: '0 * * * *', singleton: true },
  { name: 'image.reconcile', cron: '* * * * *', singleton: true },
  { name: 'outbox.retention', cron: '30 3 * * *', singleton: true },
  { name: 'lab.compact', cron: '0 4 * * *', singleton: true },
  { name: 'lab.heartbeat', cron: '*/5 * * * *', singleton: false },
  { name: 'analytics.retention', cron: '15 3 * * *', singleton: true },
  { name: 'audit.retention', cron: '45 3 * * *', singleton: true },
  { name: 'atl.probe-nonce-gc', cron: '*/10 * * * *', singleton: true },
];

const DAY_MS = 86_400_000;
/** 照片停在 UPLOADING 超过 1 小时视为放弃上传（03#storage 第 1 节“孤儿清理”） */
export const ORPHAN_UPLOAD_AGE_MS = 3600_000;
/** .incoming/ 中超过 24 小时未完成的分片目录与临时文件（02#identity-pool、03#storage） */
export const INCOMING_MAX_AGE_MS = DAY_MS;
/** processed_jobs 保留 7 天（04#queue） */
export const PROCESSED_JOBS_RETENTION_DAYS = 7;

// ---------------------------------------------------------------------------------------------
// handler
// ---------------------------------------------------------------------------------------------
export async function reportDaily(c: Container, scheduledAt: Date): Promise<void> {
  await generateDailyReport({ cfg: c.config, db: c.db, storage: c.storage, queue: c.queue, notifier: c.notifier, logger: c.logger }, { now: scheduledAt });
}

export async function shareCleanup(c: Container): Promise<number> {
  return c.social.purgeExpiredShares();
}

export async function imageReconcile(c: Container, now = new Date()): Promise<{ orphans: number; incoming: number; resubmitted: number; failed: number }> {
  // 1) 放弃上传的孤儿：UPLOADING 超过 1 小时 → 删除对象（可能已部分上传）与照片行
  let orphans = 0;
  for (const p of await findStaleUploading(c.db, new Date(now.getTime() - ORPHAN_UPLOAD_AGE_MS), 200)) {
    await c.storage.deleteObjects([p.rawKey]).catch(() => undefined);
    if (await deletePhotoRow(c.db, p.id)) orphans++;
  }
  // 2) F14 本地前缀令牌上传留下的残留分片
  const multipart = asLocalMultipart(c.storage);
  const incoming = multipart ? (await multipart.cleanupIncoming(INCOMING_MAX_AGE_MS - (now.getTime() - Date.now()))).removed : 0;
  // 3) PROCESSING 超时：交给当前图片处理驱动的对账
  const stuckBefore = new Date(now.getTime() - c.config.image.IMAGE_STUCK_AFTER_SEC * 1000);
  const r = await c.images.reconcile(stuckBefore);
  if (orphans || incoming || r.resubmitted || r.failed) c.logger.info('image.reconcile', { orphans, incoming, ...r });
  return { orphans, incoming, ...r };
}

/** 只删除 OUTBOX_DIR 之内的文件 */
function insideDir(dir: string, file: string): string | null {
  const abs = path.isAbsolute(file) ? path.resolve(file) : path.resolve(dir, file);
  const root = path.resolve(dir);
  return abs.startsWith(root + path.sep) ? abs : null;
}

export async function outboxRetention(c: Container, now = new Date()): Promise<{ emails: number; files: number; processedJobs: number }> {
  const email = c.config.email;
  const cutoff = new Date(now.getTime() - email.OUTBOX_RETENTION_DAYS * DAY_MS).toISOString();
  // 记录与 .eml 文件（repositories/outbox.ts 返回被删记录的 eml_path，由这里删除文件；只删 OUTBOX_DIR 之内的）
  const paths = await deleteOutboxBefore(c.db, cutoff);
  let files = 0;
  for (const p of paths) {
    const abs = insideDir(email.OUTBOX_DIR, p);
    if (abs && (await unlink(abs).then(() => true, () => false))) files++;
  }
  // 按日期分目录（OUTBOX_DIR/<yyyy-mm-dd>/）：删除早于保留期的整个目录（也覆盖没有数据库记录的残留 .eml）
  const cutoffDay = cutoff.slice(0, 10);
  const days = await readdir(email.OUTBOX_DIR).catch(() => [] as string[]);
  for (const d of days) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(d) && d < cutoffDay) await rm(path.join(email.OUTBOX_DIR, d), { recursive: true, force: true }).catch(() => undefined);
  }
  const processedJobs = await purgeBefore(c.db, 'processed_jobs', new Date(now.getTime() - PROCESSED_JOBS_RETENTION_DAYS * DAY_MS).toISOString());
  return { emails: paths.length, files, processedJobs };
}

type CompactFn = (db: Container['db'], before: Date) => Promise<unknown>;

/** lab.compact：由 /lab 的实现者在 repositories/lab.ts 中提供 compactRollups(db, before)；未提供时跳过 */
export async function labCompact(c: Container, now = new Date()): Promise<{ skipped: boolean }> {
  const fn = (labRepo as unknown as Record<string, unknown>).compactRollups;
  if (typeof fn !== 'function') {
    c.logger.info('lab.compact skipped', { reason: 'repositories/lab.ts 尚未提供 compactRollups' });
    return { skipped: true };
  }
  await (fn as CompactFn)(c.db, new Date(now.getTime() - 2 * DAY_MS));
  // 小时级汇总同样有保留期：否则按 route 维度的行只增不减（总纲 7.3：保留 14 天）
  await labRepo.purgeRollupsBefore(c.db, new Date(now.getTime() - labRepo.LAB_ROLLUP_RETENTION_DAYS * DAY_MS));
  return { skipped: false };
}

export async function analyticsRetention(c: Container, now = new Date()): Promise<number> {
  if (c.config.analytics.ANALYTICS_DRIVER !== 'db') return 0;           // firehose：由 S3 生命周期负责
  const cutoff = new Date(now.getTime() - c.config.analytics.ANALYTICS_RETENTION_DAYS * DAY_MS).toISOString();
  return purgeEventsBefore(c.db, cutoff);
}

export async function auditRetention(c: Container, now = new Date()): Promise<number> {
  // 多留 1 分钟余量：audit_log 的触发器拒绝删除保留期之内的行
  const cutoff = new Date(now.getTime() - c.config.core.AUDIT_RETENTION_DAYS * DAY_MS - 60_000).toISOString();
  return deleteAuditBefore(c.db, cutoff);
}

/** 注册表 → ScheduledJobDef[]（SchedulerPort.register 的输入） */
export function scheduledJobs(c: Container): ScheduledJobDef[] {
  const tz = c.config.scheduler.SCHEDULER_TIMEZONE;
  const handlers: Record<ScheduledJobName, (run: { scheduledAt: Date; runId: string }) => Promise<void>> = {
    'report.daily': async (r) => { await reportDaily(c, r.scheduledAt); },
    'share.cleanup': async () => { await shareCleanup(c); },
    'image.reconcile': async (r) => { await imageReconcile(c, r.scheduledAt); },
    'outbox.retention': async (r) => { await outboxRetention(c, r.scheduledAt); },
    'lab.compact': async (r) => { await labCompact(c, r.scheduledAt); },
    'lab.heartbeat': async () => { /* 无副作用：job_runs 的一行就是结果 */ },
    'analytics.retention': async (r) => { await analyticsRetention(c, r.scheduledAt); },
    'audit.retention': async (r) => { await auditRetention(c, r.scheduledAt); },
    'atl.probe-nonce-gc': async (r) => { await purgeExpiredNonces(c.db, Math.floor(r.scheduledAt.getTime() / 1000)); },
  };
  const heartbeat = c.config.scheduler.SCHEDULER_COMPARE_HEARTBEAT === 'on';
  return SCHEDULE
    .filter((e) => e.name !== 'lab.heartbeat' || heartbeat)
    .filter((e) => e.name !== 'atl.probe-nonce-gc' || platformMode())
    .map((e) => ({ name: e.name, cron: e.cron, timezone: tz, singleton: e.singleton, handler: handlers[e.name] }));
}
