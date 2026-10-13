// database 模块对真实 PostgreSQL 16（docker-compose.test.yml 的 postgres，默认 postgres://cloudalbum:cloudalbum@127.0.0.1:55432/cloudalbum；
// 可用 CLOUDALBUM_IT_PG_URL 覆盖）：自建档（回环地址）的探针、只读副本路由（DB_READ_HOST → dbRead，路径头 :replica）、
// 以及 image-processing 写回仓储（knexPhotoStateStore）在 pg 方言下“状态只前进”。
//   npm run test:services:up && CLOUDALBUM_IT=1 npm test
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Knex } from 'knex';
import { knexPhotoStateStore } from '../../src/adapters/image-processing/lambda.js';
import { createKnex, databasePathValue, instrumentKnex, migrateLatest } from '../../src/db/knex.js';
import { nowIso } from '../../src/db/dialect.js';
import { databaseProbe } from '../../src/modules/database-probe.js';
import { createRequestContext, runWithContext } from '../../src/observability/request-context.js';
import { testConfig } from '../adapters/aws/helpers.js';

const url = new URL(process.env.CLOUDALBUM_IT_PG_URL ?? 'postgres://cloudalbum:cloudalbum@127.0.0.1:55432/cloudalbum');
const pgEnv = {
  DB_DRIVER: 'postgres', DB_HOST: url.hostname, DB_PORT: url.port || '5432', DB_NAME: url.pathname.slice(1),
  DB_USER: decodeURIComponent(url.username), DB_PASSWORD: decodeURIComponent(url.password), DB_SSL: 'disable', DB_POOL_MAX: '4',
  DB_READ_HOST: url.hostname,
};
const { cfg } = testConfig(pgEnv);
let db: Knex;
let dbRead: Knex;

beforeAll(async () => {
  db = instrumentKnex(await createKnex(cfg), databasePathValue(cfg.db));
  dbRead = instrumentKnex(await createKnex(cfg, undefined, { read: true }), databasePathValue(cfg.db, { read: true }));
  await db.raw('drop schema if exists public cascade; create schema public;');
  await migrateLatest(db);
});

afterAll(async () => {
  await dbRead?.destroy();
  await db?.destroy();
});

describe('databaseProbe × PostgreSQL 16（自建档）', () => {
  it('select 1、服务器版本、主机分类 local、只读副本延迟', async () => {
    const r = await databaseProbe(db, cfg, { dbRead });
    expect(r.status).toBe('ok');
    expect(r.detail).toMatch(/^select 1 = [\d.]+ms · PostgreSQL 16\.\d+/);
    expect(r.detail).toContain('主机分类：local · 有只读副本 · 副本 select 1 =');
    expect(r.data).toMatchObject({ hostClass: 'local', poolPending: 0 });
  });

  it('深度探针在自建档下不查控制面', async () => {
    const r = await databaseProbe(db, cfg, { deep: true, dbRead });
    expect(r.status).toBe('ok');
    expect(r.data).not.toHaveProperty('rds');
  });

  it('只读副本路由：dbRead 上的查询在路径头记为 postgres@local:replica，主库为 postgres@local', async () => {
    const c1 = createRequestContext();
    // knex 的查询构造器是惰性的：必须在上下文内 await（真实请求中路由处理器就是这样）
    await runWithContext(c1, async () => { await dbRead.raw('select 1'); });
    expect(c1.path.get('database')).toBe('postgres@local:replica');
    const c2 = createRequestContext();
    await runWithContext(c2, async () => { await db.raw('select 1'); });
    expect(c2.path.get('database')).toBe('postgres@local');
  });
});

describe('knexPhotoStateStore × PostgreSQL 16', () => {
  it('写回“状态只前进”在 pg 方言下与 SQLite 一致', async () => {
    const now = nowIso();
    await db('users').insert({ id: 'u-it', email: 'it@example.com', auth_subject: 'u-it', created_at: now, updated_at: now });
    const old = new Date(Date.now() - 600_000).toISOString();
    await db('photos').insert([
      { id: 'pg-1', owner_id: 'u-it', raw_key: 'raw/u-it/pg-1.jpg', content_type: 'image/jpeg', status: 'PROCESSING', processing_started_at: old, processing_attempts: 1, created_at: now, updated_at: now },
      { id: 'pg-2', owner_id: 'u-it', raw_key: 'raw/u-it/pg-2.jpg', content_type: 'image/jpeg', status: 'BLOCKED', processing_started_at: old, processing_attempts: 1, created_at: now, updated_at: now },
    ]);
    const store = knexPhotoStateStore(db);
    expect((await store.listStuck(new Date(), 10)).map((s) => s.id)).toEqual(['pg-1']);
    expect(await store.countStuck(new Date())).toBe(1);
    const result = {
      photoId: 'pg-1',
      variants: [{ name: 'thumb_200' as const, key: 'variants/pg-1/thumb_200.webp', width: 200, height: 100, bytes: 10 }],
      meta: { width: 2000, height: 1000, format: 'jpeg', dominantColor: '#000000' },
      processedBy: { driver: 'lambda' as const, durationMs: 5, host: 'h' },
    };
    expect(await store.applyResult(result)).toBe('applied');
    expect(await store.applyResult(result)).toBe('ignored-duplicate');
    expect(await store.applyResult({ ...result, photoId: 'pg-2' })).toBe('ignored-stale');
    const row = await db('photos').where({ id: 'pg-1' }).first();
    expect(row).toMatchObject({ status: 'READY', width: 2000 });
    expect(row.processed_by).toEqual({ driver: 'lambda', durationMs: 5, host: 'h' });   // jsonb
    await store.bumpAttempt('pg-2');
    expect((await db('photos').where({ id: 'pg-2' }).first()).processing_attempts).toBe(2);
  });
});
