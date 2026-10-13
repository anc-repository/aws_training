// 仓储层（users、albums、notifications、outbox、audit、lab）在 SQLite 上的用例；PostgreSQL 见 identity.int.test.ts
import { afterAll, beforeAll } from 'vitest';
import knexFactory from 'knex';
import type { Knex } from 'knex';
import { MIGRATION_SOURCE } from '../../src/db/migrations/index.js';
import { migrateLatest } from '../../src/db/knex.js';
import { identityRepositorySuites } from './identity-suites.js';

let db: Knex;

beforeAll(async () => {
  db = knexFactory({
    client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true,
    migrations: { migrationSource: MIGRATION_SOURCE }, pool: { min: 1, max: 1 },
  });
  await migrateLatest(db);
});

afterAll(async () => {
  await db?.destroy();
});

identityRepositorySuites('SQLite', () => db);
