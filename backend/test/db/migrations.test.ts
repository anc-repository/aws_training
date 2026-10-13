// db/migrations：SQLite 上执行全部迁移、audit_log append-only 触发器、可回滚。PostgreSQL 见 migrations.int.test.ts。
import { afterEach, describe, expect, it } from 'vitest';
import knexFactory from 'knex';
import type { Knex } from 'knex';
import { MIGRATIONS, MIGRATION_SOURCE } from '../../src/db/migrations/index.js';
import { insertIgnore, nowIso } from '../../src/db/dialect.js';
import { migrateLatest } from '../../src/db/knex.js';
import { getMeta, setMeta } from '../../src/repositories/system-meta.js';
import { EXPECTED_TABLES } from '../helpers/tables.js';

let db: Knex | undefined;

function sqlite(): Knex {
  db = knexFactory({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
    migrations: { migrationSource: MIGRATION_SOURCE },
    pool: { min: 1, max: 1 },
  });
  return db;
}

afterEach(async () => {
  await db?.destroy();
  db = undefined;
});

describe('migrations（SQLite）', () => {
  it('执行全部迁移并建出核心业务表与 lab 表', async () => {
    const k = sqlite();
    const done = await migrateLatest(k, { auditRetentionDays: 365 });
    expect(done).toEqual(MIGRATIONS.map((m) => m.name));
    for (const t of EXPECTED_TABLES) expect(await k.schema.hasTable(t), t).toBe(true);
    expect(await migrateLatest(k)).toEqual([]);   // 幂等
  });

  it('audit_log 只能追加：UPDATE 被触发器拒绝；保留期内的 DELETE 被拒绝', async () => {
    const k = sqlite();
    await migrateLatest(k);
    await k('audit_log').insert({ ts: nowIso(), actor_type: 'system', action: 'test', result: 'success', hash: 'h1' });
    await expect(k('audit_log').update({ action: 'tampered' })).rejects.toThrow(/append-only/);
    await expect(k('audit_log').del()).rejects.toThrow(/retention/);
  });

  it('job_runs 的 (name, scheduled_at) 唯一：重复的 tick 被忽略', async () => {
    const k = sqlite();
    await migrateLatest(k);
    const row = (runId: string) => ({ run_id: runId, name: 'report.daily', scheduled_at: '2026-10-13T00:00:00.000Z', started_at: nowIso(),
      status: 'running', host: 'h', trigger: 'cron' });
    expect(await insertIgnore(k, 'job_runs', row('a'), ['name', 'scheduled_at'])).toBe(1);
    await insertIgnore(k, 'job_runs', row('b'), ['name', 'scheduled_at']);
    expect((await k('job_runs').count({ c: '*' }).first())?.c).toBe(1);
  });

  it('system_meta 读写（CFG-007 的密钥指纹）', async () => {
    const k = sqlite();
    await migrateLatest(k);
    expect(await getMeta(k, 'x')).toBeNull();
    await setMeta(k, 'x', '1');
    await setMeta(k, 'x', '2');
    expect(await getMeta(k, 'x')).toBe('2');
  });

  it('可以完整回滚', async () => {
    const k = sqlite();
    await migrateLatest(k);
    await k.migrate.rollback(undefined, true);
    for (const t of EXPECTED_TABLES) expect(await k.schema.hasTable(t), t).toBe(false);
  });
});
