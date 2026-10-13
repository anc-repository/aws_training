// cache=redis 对真实 Valkey 8（docker-compose.test.yml 的 valkey，默认 redis://127.0.0.1:56379；可用 CLOUDALBUM_IT_REDIS_URL 覆盖）。
// 自建 Valkey（回环地址）就是 cache 模块的本地档：路径头 redis@local；ElastiCache 的行为（TLS、集群协议）由单元测试覆盖。
//   npm run test:services:up && CLOUDALBUM_IT=1 npm test
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { RedisCache } from '../../../src/adapters/cache/redis.js';
import { createRequestContext, runWithContext } from '../../../src/observability/request-context.js';
import { describeCachePortContract } from './contracts/cache.contract.js';
import { makeDeps } from './helpers.js';

const url = process.env.CLOUDALBUM_IT_REDIS_URL ?? 'redis://127.0.0.1:56379';
const run = randomUUID().slice(0, 8);
const created: RedisCache[] = [];

async function newCache(env: Record<string, string> = {}): Promise<RedisCache> {
  const c = new RedisCache(makeDeps({ CACHE_DRIVER: 'redis', REDIS_URL: url, REDIS_TLS: 'off', REDIS_KEY_PREFIX: `it-${run}:`, REDIS_TIMEOUT_MS: '500', ...env }));
  created.push(c);
  await c.init();
  return c;
}

afterAll(async () => {
  for (const c of created) await c.close();
});

let n = 0;
// 每个用例一个新的键前缀，互不干扰
describeCachePortContract('redis（Valkey 8，Docker）', { stores: true, create: () => newCache({ REDIS_KEY_PREFIX: `it-${run}-${n++}:` }) });

describe('RedisCache × Valkey', () => {
  it('回环地址 → 路径头 redis@local；值以 JSON 存在带前缀的键里，并带 TTL', async () => {
    const c = await newCache();
    const ctx = createRequestContext();
    await runWithContext(ctx, () => c.wrap('feed:{u:1}:v1:p1', 30, async () => ({ items: [1, 2] })));
    expect(ctx.path.get('cache')).toBe('redis@local:miss');
    const raw = await c.redisClient();
    expect(await raw.get(`it-${run}:feed:{u:1}:v1:p1`)).toBe('{"items":[1,2]}');
    const ttl = await raw.ttl(`it-${run}:feed:{u:1}:v1:p1`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(30);
  });

  it('incr 首次创建时设置 TTL（版本号键 7 天）', async () => {
    const c = await newCache();
    expect(await c.incr('ver:{u:9}', 604_800)).toBe(1);
    const raw = await c.redisClient();
    expect(await raw.ttl(`it-${run}:ver:{u:9}`)).toBeGreaterThan(604_000);
  });

  it('深度探针读取 INFO replication / memory', async () => {
    const c = await newCache();
    const r = await c.probe({ deep: true });
    expect(r.status === 'ok' || r.status === 'degraded').toBe(true);
    expect(r.detail).toContain('自建 Valkey（本机）');
    expect(r.data).toMatchObject({ role: 'master', hostClass: 'local' });
  });

  it('连不上（端口无监听）→ init 失败，但请求 fail-open：error-bypass，loader 照常返回', async () => {
    const c = new RedisCache(makeDeps({ CACHE_DRIVER: 'redis', REDIS_URL: 'redis://127.0.0.1:1', REDIS_TLS: 'off', REDIS_TIMEOUT_MS: '100' }));
    created.push(c);
    await expect(c.init()).rejects.toThrow(/按未命中处理/);
    const ctx = createRequestContext();
    const t0 = Date.now();
    const v = await runWithContext(ctx, () => c.wrap('k', 10, async () => 'db'));
    expect(v).toBe('db');
    expect(ctx.path.get('cache')).toBe('redis@local:error-bypass');
    expect(Date.now() - t0).toBeLessThan(1000);
    expect((await c.probe()).status).toBe('error');
  });
});
