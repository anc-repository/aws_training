// LockPort 的 cluster 档：pg（PostgreSQL 16 会话级 advisory lock）与 redis（Valkey 8 的 SET NX PX + 带令牌释放）。
// docker-compose.test.yml 的服务；地址可用 CLOUDALBUM_IT_PG_URL / CLOUDALBUM_IT_REDIS_URL 覆盖。
//   npm run test:services:up && CLOUDALBUM_IT=1 npm test
import { randomUUID } from 'node:crypto';
import type { Knex } from 'knex';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RedisCache } from '../../src/adapters/cache/redis.js';
import { advisoryKey, PgLock } from '../../src/adapters/lock/pg.js';
import { RedisLock } from '../../src/adapters/lock/redis.js';
import { pickLock } from '../../src/adapters/lock/index.js';
import { createKnex } from '../../src/db/knex.js';
import { makeDeps, testConfig } from './aws/helpers.js';

const pgUrl = new URL(process.env.CLOUDALBUM_IT_PG_URL ?? 'postgres://cloudalbum:cloudalbum@127.0.0.1:55432/cloudalbum');
const pgEnv = {
  DB_DRIVER: 'postgres', DB_HOST: pgUrl.hostname, DB_PORT: pgUrl.port || '5432', DB_NAME: pgUrl.pathname.slice(1),
  DB_USER: decodeURIComponent(pgUrl.username), DB_PASSWORD: decodeURIComponent(pgUrl.password), DB_SSL: 'disable', DB_POOL_MAX: '4',
};
const redisUrl = process.env.CLOUDALBUM_IT_REDIS_URL ?? 'redis://127.0.0.1:56379';

describe('PgLock（advisory lock）', () => {
  let db1: Knex;
  let db2: Knex;
  beforeAll(async () => {
    const { cfg } = testConfig(pgEnv);
    db1 = await createKnex(cfg);
    db2 = await createKnex(cfg);
  });
  afterAll(async () => {
    await db1?.destroy();
    await db2?.destroy();
  });

  it('两个连接池（相当于两台实例）互斥；release 后另一方可获得；锁名映射为稳定的 64 位键', async () => {
    const deps = makeDeps(pgEnv, { credentials: false });
    const a = new PgLock({ ...deps, db: db1 });
    const b = new PgLock({ ...deps, db: db2 });
    expect(a.scope).toBe('cluster');
    expect(advisoryKey('job-report.daily')).toBe(advisoryKey('job-report.daily'));
    const name = `it-${randomUUID()}`;
    const la = await a.tryAcquire(name, 60);
    expect(la).not.toBeNull();
    expect(await b.tryAcquire(name, 60)).toBeNull();
    await la!.release();
    const lb = await b.tryAcquire(name, 60);
    expect(lb).not.toBeNull();
    await lb!.release();
    await lb!.release();          // 幂等
  });

  it('pickLock：DB_DRIVER=postgres 时选 pg', () => {
    expect(pickLock({ ...makeDeps(pgEnv, { credentials: false }), db: db1 }).driver).toBe('pg');
  });
});

describe('RedisLock（SET NX PX）', () => {
  const caches: RedisCache[] = [];
  afterAll(async () => {
    for (const c of caches) await c.close();
  });

  async function lock(): Promise<RedisLock> {
    const deps = makeDeps({ CACHE_DRIVER: 'redis', REDIS_URL: redisUrl, REDIS_TLS: 'off', REDIS_KEY_PREFIX: `it-lock-${randomUUID().slice(0, 6)}:` }, { credentials: false });
    const cache = new RedisCache(deps);
    await cache.init();
    caches.push(cache);
    return new RedisLock({ ...deps, cache });
  }

  it('同名锁互斥；只有持有者的令牌能释放；TTL 到期后自动释放', async () => {
    const a = await lock();
    const name = `it-${randomUUID()}`;
    const la = await a.tryAcquire(name, 60);
    expect(la).not.toBeNull();
    expect(await a.tryAcquire(name, 60)).toBeNull();
    await la!.release();
    expect(await a.tryAcquire(name, 1)).not.toBeNull();
    await new Promise((r) => setTimeout(r, 1200));
    const again = await a.tryAcquire(name, 60);
    expect(again).not.toBeNull();
    await again!.release();
  });
});
