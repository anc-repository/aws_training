// backend/src/adapters/notification/migrate.ts —— notification 的数据迁移（总纲 9.3；registry migration: scripts/migrate/notification）
//
//   plan    统计 email_enabled=true 的用户（保留域名单列，不建订阅）
//   up      为还没有 SNS 订阅的这些用户逐个 subscribeEmail()：带 userId（管理员另加 audience=admin）过滤策略，每人收到一封确认邮件
//   down    删除全部用户订阅（dropSubscription），email_enabled 保留在本地，回到 db 驱动后用户设置不变
//   verify  up 之后：每个需要订阅的用户都有订阅 ARN；down 之后：没有残留的订阅 ARN
// 幂等：up 跳过已有 ARN 的用户；down 跳过没有 ARN 的用户。迁移框架（backend/src/cli.ts migrate-module、scripts/migrate/_lib）
// 尚未实现，集成阶段把 `migrate-module notification <dir>` 接到这里；在那之前卡片用 experiments/notification/subscribe-users.ts
// 经 PUT /api/notifications/prefs 逐个开通（走同一个 subscribeEmail）。
import type { Knex } from 'knex';
import { isReservedAddress } from '../email/reserved.js';

export interface MigrationTarget {
  subscribeEmail(userId: string, address: string): Promise<{ pendingConfirmation: boolean }>;
  dropSubscription(userId: string): Promise<{ removed: boolean }>;
}

export interface NotificationMigrationReport { copied: number; skipped: number; failed: number; durationMs: number; errors: string[] }

interface Row { user_id: string; email: string; sns_subscription_arn: string | null; sns_status: string | null }

async function enabledUsers(db: Knex): Promise<Row[]> {
  return (await db('notification_prefs as p').join('users as u', 'u.id', 'p.user_id').where('p.email_enabled', true)
    .select('p.user_id', 'u.email', 'p.sns_subscription_arn', 'p.sns_status').orderBy('p.user_id')) as Row[];
}

export async function planNotificationMigration(db: Knex): Promise<{ items: number; notes: string[] }> {
  const rows = await enabledUsers(db);
  const reserved = rows.filter((r) => isReservedAddress(r.email)).length;
  const todo = rows.filter((r) => !isReservedAddress(r.email) && !r.sns_subscription_arn).length;
  return {
    items: todo,
    notes: [
      `${rows.length} 个用户开启了邮件通知；需要新建订阅 ${todo} 个，保留域名 ${reserved} 个（不建订阅）`,
      '每个新订阅都会给用户发一封 AWS Notifications 的确认邮件；用户确认之前，他的站外通知是中断的（请提前告知）',
    ],
  };
}

export async function migrateNotificationUp(db: Knex, target: MigrationTarget, opts: { dryRun?: boolean } = {}): Promise<NotificationMigrationReport> {
  const t0 = Date.now();
  const report: NotificationMigrationReport = { copied: 0, skipped: 0, failed: 0, durationMs: 0, errors: [] };
  for (const r of await enabledUsers(db)) {
    if (r.sns_subscription_arn || isReservedAddress(r.email)) {
      report.skipped += 1;
      continue;
    }
    if (opts.dryRun) {
      report.copied += 1;
      continue;
    }
    try {
      await target.subscribeEmail(r.user_id, r.email);
      report.copied += 1;
    } catch (e) {
      report.failed += 1;
      report.errors.push(`${r.user_id}: ${(e as Error).message}`);
    }
  }
  report.durationMs = Date.now() - t0;
  return report;
}

export async function migrateNotificationDown(db: Knex, target: MigrationTarget, opts: { dryRun?: boolean } = {}): Promise<NotificationMigrationReport> {
  const t0 = Date.now();
  const report: NotificationMigrationReport = { copied: 0, skipped: 0, failed: 0, durationMs: 0, errors: [] };
  const rows = (await db('notification_prefs').whereNotNull('sns_subscription_arn').select('user_id')) as Array<{ user_id: string }>;
  for (const r of rows) {
    if (opts.dryRun) {
      report.copied += 1;
      continue;
    }
    try {
      await target.dropSubscription(r.user_id);
      report.copied += 1;
    } catch (e) {
      report.failed += 1;
      report.errors.push(`${r.user_id}: ${(e as Error).message}`);
    }
  }
  report.durationMs = Date.now() - t0;
  return report;
}

export async function verifyNotificationMigration(db: Knex, direction: 'up' | 'down'): Promise<{ ok: boolean; mismatches: Array<{ key: string; reason: string }> }> {
  const mismatches: Array<{ key: string; reason: string }> = [];
  if (direction === 'up') {
    for (const r of await enabledUsers(db)) {
      if (!isReservedAddress(r.email) && !r.sns_subscription_arn) mismatches.push({ key: r.user_id, reason: '开启了邮件通知但没有 SNS 订阅' });
    }
  } else {
    const rows = (await db('notification_prefs').whereNotNull('sns_subscription_arn').select('user_id')) as Array<{ user_id: string }>;
    for (const r of rows) mismatches.push({ key: r.user_id, reason: '仍有 SNS 订阅 ARN' });
  }
  return { ok: mismatches.length === 0, mismatches };
}
