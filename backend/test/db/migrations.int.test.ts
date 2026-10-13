// db/migrations 在 PostgreSQL 16 上执行（双方言，总纲 4.3 第 4 条）。需要 Docker：
//   npm run test:services:up        # docker-compose.test.yml：postgres:16、valkey:8、localstack
//   CLOUDALBUM_IT=1 npm test
// 连接串可用 CLOUDALBUM_IT_PG_URL 覆盖（默认 postgres://cloudalbum:cloudalbum@127.0.0.1:55432/cloudalbum）。
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import knexFactory from 'knex';
import type { Knex } from 'knex';
import { MIGRATIONS, MIGRATION_SOURCE } from '../../src/db/migrations/index.js';
import { nowIso } from '../../src/db/dialect.js';
import { migrateLatest } from '../../src/db/knex.js';
import { EXPECTED_TABLES } from '../helpers/tables.js';

const url = process.env.CLOUDALBUM_IT_PG_URL ?? 'postgres://cloudalbum:cloudalbum@127.0.0.1:55432/cloudalbum';
let db: Knex;

beforeAll(async () => {
  db = knexFactory({ client: 'pg', connection: url, migrations: { migrationSource: MIGRATION_SOURCE }, pool: { min: 0, max: 2 } });
  await db.raw('drop schema if exists public cascade; create schema public;');
});

afterAll(async () => {
  await db?.destroy();
});

describe('migrations（PostgreSQL 16）', () => {
  it('执行全部迁移', async () => {
    expect(await migrateLatest(db, { auditRetentionDays: 30 })).toEqual(MIGRATIONS.map((m) => m.name));
    for (const t of EXPECTED_TABLES) expect(await db.schema.hasTable(t), t).toBe(true);
  });

  it('audit_log 的 plpgsql 触发器拒绝 UPDATE 与保留期内的 DELETE', async () => {
    await db('audit_log').insert({ ts: nowIso(), actor_type: 'system', action: 'test', result: 'success', hash: 'h1' });
    await expect(db('audit_log').update({ action: 'tampered' })).rejects.toThrow(/append-only/);
    await expect(db('audit_log').del()).rejects.toThrow(/retention/);
  });

  it('可以完整回滚', async () => {
    await db.migrate.rollback(undefined, true);
    for (const t of EXPECTED_TABLES) expect(await db.schema.hasTable(t), t).toBe(false);
  });
});
