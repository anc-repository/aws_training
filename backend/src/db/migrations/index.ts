// backend/src/db/migrations/index.ts —— 迁移清单（双方言可执行，总纲 §4.3 第 4 条）
//
// 用静态导入的 MigrationSource，而不是让 Knex 扫描目录：tsx（开发 / 测试）与 dist（EC2）行为一致，ESM 下也不依赖文件扩展名。
// 新增迁移：在本目录新建 `<yyyymmdd>_<nnnn>_<name>.ts`（导出 up / down），并追加到 MIGRATIONS 末尾；已发布的迁移不得修改。
import type { Knex } from 'knex';
import * as m0001 from './20261013_0001_core.js';
import * as m0002 from './20261013_0002_social_notify.js';
import * as m0003 from './20261013_0003_jobs_audit.js';
import * as m0004 from './20261013_0004_lab.js';
import * as m0005 from './20261014_0005_atl_platform.js';

export interface Migration {
  name: string;
  up(knex: Knex): Promise<void>;
  down(knex: Knex): Promise<void>;
}

export const MIGRATIONS: readonly Migration[] = [
  { name: '20261013_0001_core', ...m0001 },
  { name: '20261013_0002_social_notify', ...m0002 },
  { name: '20261013_0003_jobs_audit', ...m0003 },
  { name: '20261013_0004_lab', ...m0004 },
  { name: '20261014_0005_atl_platform', ...m0005 },
];

export const MIGRATION_SOURCE: Knex.MigrationSource<Migration> = {
  getMigrations: async () => [...MIGRATIONS],
  getMigrationName: (m) => m.name,
  getMigration: async (m) => m,
};
