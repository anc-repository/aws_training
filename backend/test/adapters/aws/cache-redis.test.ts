// cache=redis：端口契约（内存 Redis 客户端）+ 驱动细节（主机类别、fail-open、键前缀、计时、探针、控制面）
import { DescribeReplicationGroupsCommand, DescribeServerlessCachesCommand, ElastiCacheClient } from '@aws-sdk/client-elasticache';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, describe, expect, it } from 'vitest';
import { RedisCache, elasticacheResourceOf, redisHostClass } from '../../../src/adapters/cache/redis.js';
import { createRequestContext, runWithContext } from '../../../src/observability/request-context.js';
import { ENABLE } from '../../helpers/config.js';
import { describeCachePortContract } from './contracts/cache.contract.js';
import { FakeRedis } from './fake-redis.js';
import { awsError, makeDeps } from './helpers.js';

const elasticacheEnv = { ...ENABLE.iamRole, ...ENABLE.elasticache };
const ec = mockClient(ElastiCacheClient);
afterEach(() => ec.reset());

function newCache(env: Record<string, string> = elasticacheEnv, opts: { credentials?: boolean } = {}) {
  const fake = new FakeRedis();
  const cache = new RedisCache(makeDeps(env, { credentials: opts.credentials ?? true }), { client: fake.asClient() });
  return { fake, cache };
}

describeCachePortContract('redis（内存客户端）', { stores: true, create: async () => newCache().cache });

describe('RedisCache 驱动细节', () => {
  it('主机类别：回环 → local，*.cache.amazonaws.com → elasticache，其他 → remote', () => {
    expect(redisHostClass('redis://127.0.0.1:6379')).toBe('local');
    expect(redisHostClass(ENABLE.elasticache.REDIS_URL)).toBe('elasticache');
    expect(redisHostClass('redis://cache.internal:6379')).toBe('remote');
    expect(newCache({ ...ENABLE.valkeyLocal }).cache.hostClass).toBe('local');
  });

  it('ElastiCache 端点 → 复制组 ID / Serverless 缓存名', () => {
    expect(elasticacheResourceOf('rediss://master.cloudalbum-lab-cache.abc123.apne1.cache.amazonaws.com:6379')).toEqual({ kind: 'replication-group', id: 'cloudalbum-lab-cache' });
    expect(elasticacheResourceOf('redis://cloudalbum-lab-cache.abc123.ng.0001.apne1.cache.amazonaws.com:6379')).toEqual({ kind: 'replication-group', id: 'cloudalbum-lab-cache' });
    expect(elasticacheResourceOf('rediss://clustercfg.rg1.abc123.apne1.cache.amazonaws.com:6379')).toEqual({ kind: 'replication-group', id: 'rg1' });
    expect(elasticacheResourceOf('rediss://cloudalbum-lab-cache-x1y2z3.serverless.apne1.cache.amazonaws.com:6379')).toEqual({ kind: 'serverless', id: 'cloudalbum-lab-cache' });
    expect(elasticacheResourceOf('redis://127.0.0.1:6379')).toBeNull();
  });

  it('所有键加 REDIS_KEY_PREFIX，值为 JSON', async () => {
    const { fake, cache } = newCache({ ...elasticacheEnv, REDIS_KEY_PREFIX: 'lab:' });
    await cache.set('photo:1', { a: 1 }, 30);
    expect([...fake.store.keys()]).toEqual(['lab:photo:1']);
    expect(fake.store.get('lab:photo:1')!.value).toBe('{"a":1}');
  });

  it('路径头：redis@elasticache:miss → redis@elasticache:hit；wrap 内部的 get / set 记入 Server-Timing 的 cache 项', async () => {
    const { cache } = newCache();
    const c1 = createRequestContext();
    await runWithContext(c1, () => cache.wrap('feed:{pub}:v1:p1', 60, async () => [1, 2]));
    expect(c1.path.get('cache')).toBe('redis@elasticache:miss');
    expect(c1.timing.entries().find((e) => e.module === 'cache')?.count).toBe(2);
    const c2 = createRequestContext();
    await runWithContext(c2, () => cache.wrap('feed:{pub}:v1:p1', 60, async () => [9]));
    expect(c2.path.get('cache')).toBe('redis@elasticache:hit');
  });

  it('fail-open：断线时按未命中处理（error-bypass），请求照常成功；incr 退回进程内计数', async () => {
    const { fake, cache } = newCache();
    fake.broken = true;
    const ctx = createRequestContext();
    const v = await runWithContext(ctx, () => cache.wrap('k', 60, async () => 'from-db'));
    expect(v).toBe('from-db');
    expect(ctx.path.get('cache')).toBe('redis@elasticache:error-bypass');
    expect((await cache.get('k')).outcome).toBe('error-bypass');
    await expect(cache.set('k', 1, 10)).resolves.toBeUndefined();
    await expect(cache.del(['k'])).resolves.toBeUndefined();
    expect(await cache.incr('rate', 60)).toBe(1);
    expect(await cache.incr('rate', 60)).toBe(2);
    const probe = await cache.probe();
    expect(probe.status).toBe('error');
    expect(probe.detail).toContain('fail-open');
    fake.broken = false;
    const healed = await cache.probe();
    expect(healed.status).toBe('degraded');                     // 最近 1 分钟错误率仍 > 1%
    expect(healed.detail).toContain('已按未命中处理');
  });

  it('探针：PING > 50ms → degraded；正常时 ok 并带命中率', async () => {
    const { fake, cache } = newCache();
    await cache.wrap('x', 60, async () => 1);
    await cache.wrap('x', 60, async () => 1);
    const ok = await cache.probe();
    expect(ok.status).toBe('ok');
    expect(ok.detail).toContain('ElastiCache');
    expect(ok.data).toMatchObject({ hostClass: 'elasticache', hitRatio1m: 0.5 });
    fake.latencyMs = 60;
    const slow = await cache.probe();
    expect(slow.status).toBe('degraded');
  });

  it('深度探针：INFO replication / memory / stats + DescribeReplicationGroups', async () => {
    ec.on(DescribeReplicationGroupsCommand).resolves({ ReplicationGroups: [{ ReplicationGroupId: 'cloudalbum-lab-cache', Status: 'available', MultiAZ: 'enabled', MemberClusters: ['a', 'b'] }] });
    const { fake, cache } = newCache();
    const r = await cache.probe({ deep: true });
    expect(r.status).toBe('ok');
    expect(r.detail).toContain('复制组 cloudalbum-lab-cache available');
    expect(r.data).toMatchObject({ role: 'master', connectedReplicas: 1, nodes: 2 });
    fake.infoText.stats = 'evicted_keys:12\r\n';
    expect((await cache.probe({ deep: true })).status).toBe('degraded');
    ec.on(DescribeReplicationGroupsCommand).rejects(awsError('ReplicationGroupNotFoundFault', 404));
    expect((await cache.probe({ deep: true })).status).toBe('error');
  });

  it('深度探针：Serverless 缓存；无凭证时只执行 INFO（CRED-004）；自建 Valkey 不查控制面', async () => {
    ec.on(DescribeServerlessCachesCommand).resolves({ ServerlessCaches: [{ ServerlessCacheName: 'cl', Status: 'creating' }] });
    const sl = newCache({ ...elasticacheEnv, REDIS_URL: 'rediss://cl-a1b2c3.serverless.apne1.cache.amazonaws.com:6379', REDIS_CLIENT_MODE: 'cluster' });
    expect((await sl.cache.probe({ deep: true })).status).toBe('degraded');
    const noCreds = newCache({ ...ENABLE.elasticache }, { credentials: false });
    expect((await noCreds.cache.probe({ deep: true })).detail).toContain('CRED-004');
    const local = newCache({ ...ENABLE.valkeyLocal });
    const r = await local.cache.probe({ deep: true });
    expect(r.detail).toContain('自建 Valkey');
    expect(ec.commandCalls(DescribeReplicationGroupsCommand)).toHaveLength(0);
  });
});
