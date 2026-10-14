// backend/src/cli/migrate-module.ts —— `cloudalbum migrate-module <id> plan|up|down|verify [--dry-run]`（总纲 9.3；wave1-integration）
//
// 通用迁移框架（scripts/migrate/_lib：同时实例化源驱动与目标驱动、断点、只读窗口）尚未实现；本命令目前只接入 notification
// （adapters/notification/migrate.ts），其余模块仍按脚手架约定以退出码 2 结束（scripts/module enable / disable 用 --no-migrate）。
//
// notification 的约束（04#notification 第 6 节）：
//   - up / down 的目标是 SnsNotifier，必须在 NOTIFY_DRIVER=sns 的配置下运行。scripts/module disable 的第 3 步满足这一点（切回 db 之前）；
//     enable 的第 6 步在写入 modules.d 之前运行，实例上仍是 db 驱动，所以 enable 仍需 --no-migrate，切换完成后在实例上执行
//     `node dist/cli.js migrate-module notification up`（或 experiments/notification/subscribe-users.ts 经 API 逐个开通）。
//   - verify 不带方向：取最近一次 up / down 记在 system_meta 的方向；没有记录时按当前驱动推断（sns → up，否则 down）。
//   - --dry-run 只输出 plan（总纲 9.3 第 7 条）。
// 输出：stdout 一个 JSON 对象；退出码 0 成功，1 有失败条目或校验不一致，2 用法错误 / 尚未接入 / 驱动不对。
import type { Container } from '../container.js';
import {
  migrateNotificationDown, migrateNotificationUp, planNotificationMigration, verifyNotificationMigration, type MigrationTarget,
} from '../adapters/notification/migrate.js';
import { getMeta, setMeta } from '../repositories/system-meta.js';

export type MigrateDirection = 'plan' | 'up' | 'down' | 'verify';
export const MIGRATE_DIRECTIONS: readonly MigrateDirection[] = ['plan', 'up', 'down', 'verify'];
/** 已接入 migrate-module 的模块 */
export const MIGRATABLE_MODULES = ['notification'] as const;

export interface MigrateResult {
  exitCode: 0 | 1 | 2;
  body: Record<string, unknown>;
}

const lastDirectionKey = (id: string) => `migrate.${id}.lastDirection`;

function asTarget(c: Pick<Container, 'notifier'>): MigrationTarget | null {
  const n = c.notifier as unknown as Partial<MigrationTarget> & { meta: { driver: string } };
  return n.meta.driver === 'sns' && typeof n.subscribeEmail === 'function' && typeof n.dropSubscription === 'function'
    ? (n as MigrationTarget) : null;
}

export async function runMigrateModule(
  c: Pick<Container, 'db' | 'notifier'>, id: string, direction: string, opts: { dryRun?: boolean } = {},
): Promise<MigrateResult> {
  if (!(MIGRATE_DIRECTIONS as readonly string[]).includes(direction)) {
    return { exitCode: 2, body: { ok: false, error: 'BAD_DIRECTION', message: `direction 必须是 ${MIGRATE_DIRECTIONS.join(' | ')}` } };
  }
  if (id !== 'notification') {
    return {
      exitCode: 2,
      body: { ok: false, error: 'NOT_IMPLEMENTED', module: id, message: `migrate-module ${id}：尚未实现（通用迁移框架 scripts/migrate/_lib 未接入；scripts/module 用 --no-migrate）` },
    };
  }
  const dir = direction as MigrateDirection;
  if (dir === 'plan' || ((dir === 'up' || dir === 'down') && opts.dryRun)) {
    const plan = await planNotificationMigration(c.db);
    return { exitCode: 0, body: { ok: true, module: id, direction: 'plan', ...(dir !== 'plan' ? { requested: dir, dryRun: true } : {}), ...plan } };
  }
  if (dir === 'verify') {
    const recorded = await getMeta(c.db, lastDirectionKey(id));
    const against: 'up' | 'down' = recorded === 'up' || recorded === 'down' ? recorded : asTarget(c) ? 'up' : 'down';
    const v = await verifyNotificationMigration(c.db, against);
    return { exitCode: v.ok ? 0 : 1, body: { module: id, direction: 'verify', against, ...v } };
  }
  const target = asTarget(c);
  if (!target) {
    return {
      exitCode: 2,
      body: {
        ok: false, error: 'DRIVER_NOT_ACTIVE', module: id, direction: dir, driver: c.notifier.meta.driver,
        message: dir === 'up'
          ? 'migrate-module notification up 需要 NOTIFY_DRIVER=sns：先 scripts/module enable notification --no-migrate，切换完成后再在实例上执行本命令'
          : 'migrate-module notification down 需要在仍是 NOTIFY_DRIVER=sns 时执行（scripts/module disable 的第 3 步）',
      },
    };
  }
  const report = dir === 'up' ? await migrateNotificationUp(c.db, target) : await migrateNotificationDown(c.db, target);
  await setMeta(c.db, lastDirectionKey(id), dir);
  return { exitCode: report.failed > 0 ? 1 : 0, body: { ok: report.failed === 0, module: id, direction: dir, ...report } };
}
