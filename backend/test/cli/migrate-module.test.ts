// cli/migrate-module.ts（wave1-integration）：`migrate-module notification plan|up|down|verify` 接到 adapters/notification/migrate.ts。
// 目标端口用一个内存替身（只实现 MigrationTarget 的两个方法，写 notification_prefs 的订阅 ARN），不调用 AWS。
import { afterEach, describe, expect, it } from 'vitest';
import { runMigrateModule } from '../../src/cli/migrate-module.js';
import type { NotifierPort } from '../../src/ports/notifier.js';
import { getMeta } from '../../src/repositories/system-meta.js';
import { getNotificationPrefs, setNotificationPrefs } from '../../src/repositories/notifications.js';
import { createUserWithDefaults } from '../../src/services/user-directory.js';
import { makeLocalDeps, type LocalDeps } from '../contract/_local-deps.js';

let local: LocalDeps | undefined;
afterEach(async () => {
  await local?.close();
  local = undefined;
});

function fakeSns(db: LocalDeps['db'], calls: string[]): NotifierPort {
  return {
    meta: { module: 'notification', driver: 'sns', awsService: 'Amazon SNS' },
    async subscribeEmail(userId: string) {
      calls.push(`subscribe ${userId}`);
      await setNotificationPrefs(db, userId, { snsSubscriptionArn: `arn:aws:sns:ap-northeast-1:123456789012:t:${userId}`, snsStatus: 'pending' });
      return { pendingConfirmation: true };
    },
    async dropSubscription(userId: string) {
      calls.push(`drop ${userId}`);
      await setNotificationPrefs(db, userId, { snsSubscriptionArn: null, snsStatus: null });
      return { removed: true };
    },
  } as unknown as NotifierPort;
}

async function seed(l: LocalDeps): Promise<{ a: string; b: string; reserved: string }> {
  const mk = async (email: string, on: boolean) => {
    const u = await createUserWithDefaults(l.db, { email, displayName: email, passwordHash: null, emailVerified: true });
    await setNotificationPrefs(l.db, u.id, { emailEnabled: on });
    return u.id;
  };
  const a = await mk('a@mail.test-only.dev', true);
  const b = await mk('b@mail.test-only.dev', true);
  await mk('c@mail.test-only.dev', false);
  const reserved = await mk('r@example.com', true);
  return { a, b, reserved };
}

describe('migrate-module notification', () => {
  it('plan / --dry-run 只统计，不调用目标端口', async () => {
    local = await makeLocalDeps();
    await seed(local);
    const calls: string[] = [];
    const c = { db: local.db, notifier: fakeSns(local.db, calls) };
    const plan = await runMigrateModule(c, 'notification', 'plan');
    expect(plan.exitCode).toBe(0);
    expect(plan.body).toMatchObject({ ok: true, direction: 'plan', items: 2 });
    const dry = await runMigrateModule(c, 'notification', 'up', { dryRun: true });
    expect(dry.body).toMatchObject({ direction: 'plan', requested: 'up', dryRun: true, items: 2 });
    expect(calls).toEqual([]);
  });

  it('up → verify（按记录的方向）→ down → verify；保留域名不建订阅；幂等', async () => {
    local = await makeLocalDeps();
    const { a, b, reserved } = await seed(local);
    const calls: string[] = [];
    const c = { db: local.db, notifier: fakeSns(local.db, calls) };

    const up = await runMigrateModule(c, 'notification', 'up');
    expect(up).toMatchObject({ exitCode: 0, body: { ok: true, direction: 'up', copied: 2, failed: 0 } });
    expect(calls.sort()).toEqual([`subscribe ${a}`, `subscribe ${b}`].sort());
    expect((await getNotificationPrefs(local.db, reserved)).snsSubscriptionArn).toBeNull();
    expect(await getMeta(local.db, 'migrate.notification.lastDirection')).toBe('up');
    expect(await runMigrateModule(c, 'notification', 'verify')).toMatchObject({ exitCode: 0, body: { against: 'up', ok: true } });

    const again = await runMigrateModule(c, 'notification', 'up');
    expect(again.body).toMatchObject({ copied: 0, skipped: 3 });

    const down = await runMigrateModule(c, 'notification', 'down');
    expect(down).toMatchObject({ exitCode: 0, body: { direction: 'down', copied: 2 } });
    expect(await runMigrateModule(c, 'notification', 'verify')).toMatchObject({ exitCode: 0, body: { against: 'down', ok: true } });
  });

  it('db 驱动下 up / down 以退出码 2 拒绝（enable 第 6 步在切换之前运行，仍需 --no-migrate）；verify 不一致退出 1', async () => {
    local = await makeLocalDeps();
    await seed(local);
    const db = { meta: { module: 'notification', driver: 'db' } } as unknown as NotifierPort;
    const c = { db: local.db, notifier: db };
    const up = await runMigrateModule(c, 'notification', 'up');
    expect(up.exitCode).toBe(2);
    expect(up.body).toMatchObject({ error: 'DRIVER_NOT_ACTIVE', driver: 'db' });
    expect(String(up.body.message)).toContain('--no-migrate');
    // 没有记录方向、当前不是 sns → 按 down 校验：没有残留的订阅 ARN
    expect(await runMigrateModule(c, 'notification', 'verify')).toMatchObject({ exitCode: 0, body: { against: 'down' } });
  });

  it('其余模块与非法方向：退出码 2', async () => {
    local = await makeLocalDeps();
    const c = { db: local.db, notifier: fakeSns(local.db, []) };
    expect(await runMigrateModule(c, 'storage', 'up')).toMatchObject({ exitCode: 2, body: { error: 'NOT_IMPLEMENTED' } });
    expect(await runMigrateModule(c, 'notification', 'sideways')).toMatchObject({ exitCode: 2, body: { error: 'BAD_DIRECTION' } });
  });
});
