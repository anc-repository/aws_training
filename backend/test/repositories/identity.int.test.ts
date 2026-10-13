// 仓储层在 PostgreSQL 16 上跑同一套用例（双方言，总纲 4.3 第 4 条）。需要 Docker：
//   npm run test:services:up && CLOUDALBUM_IT=1 npm test
// 使用独立 schema（it_identity），不与 migrations.int.test.ts 的 public schema 互相干扰。
import { afterAll, beforeAll } from 'vitest';
import knexFactory from 'knex';
import type { Knex } from 'knex';
import { MIGRATION_SOURCE } from '../../src/db/migrations/index.js';
import { migrateLatest } from '../../src/db/knex.js';
import { identityRepositorySuites } from './identity-suites.js';

const url = process.env.CLOUDALBUM_IT_PG_URL ?? 'postgres://cloudalbum:cloudalbum@127.0.0.1:55432/cloudalbum';
const SCHEMA = 'it_identity';
let db: Knex;

beforeAll(async () => {
  const admin = knexFactory({ client: 'pg', connection: url, pool: { min: 0, max: 1 } });
  await admin.raw(`drop schema if exists ${SCHEMA} cascade; create schema ${SCHEMA};`);
  await admin.destroy();
  db = knexFactory({
    client: 'pg', connection: url, searchPath: [SCHEMA], pool: { min: 0, max: 4 },
    migrations: { migrationSource: MIGRATION_SOURCE, schemaName: SCHEMA },
  });
  await migrateLatest(db, { auditRetentionDays: 30 });
});

afterAll(async () => {
  await db?.destroy();
});

identityRepositorySuites('PostgreSQL 16', () => db);
