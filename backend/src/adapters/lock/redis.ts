// backend/src/adapters/lock/redis.ts —— 内部 LockPort 的 `redis` 实现（scope=cluster）
// Redis `SET <prefix>lock:<name> <令牌> PX <ttl> NX` + 带令牌的释放（Lua：值仍是自己的令牌才 DEL）；CACHE_DRIVER=redis 时全集群互斥。
// 复用 cache 适配器（RedisCache）的同一条连接与键前缀 REDIS_KEY_PREFIX（RedisCache.redisClient()）。
import { randomUUID } from 'node:crypto';
import type { Lease, LockPort } from '../../ports/lock.js';
import type { RedisLike } from '../cache/redis.js';
import type { AdapterDeps } from '../types.js';

const RELEASE = "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end";

interface RedisClientSource { redisClient(): Promise<RedisLike>; readonly keyPrefix?: string }

export class RedisLock implements LockPort {
  readonly driver = 'redis' as const;
  readonly scope = 'cluster' as const;

  constructor(protected readonly deps: AdapterDeps, private readonly source?: RedisClientSource) {}

  private src(): RedisClientSource {
    const s = this.source ?? (this.deps.cache as unknown as Partial<RedisClientSource> | undefined);
    if (!s || typeof s.redisClient !== 'function') throw new Error('RedisLock：cache 适配器不是 redis（container 装配顺序错误）');
    return s as RedisClientSource;
  }

  async tryAcquire(name: string, ttlSec: number): Promise<Lease | null> {
    const src = this.src();
    const client = await src.redisClient();
    const key = `${src.keyPrefix ?? ''}lock:${name}`;
    const token = randomUUID();
    const ok = await client.set(key, token, 'PX', Math.max(1000, Math.ceil(ttlSec * 1000)), 'NX');
    if (ok !== 'OK') return null;
    let released = false;
    return {
      name,
      release: async () => {
        if (released) return;
        released = true;
        await client.eval(RELEASE, 1, key, token);
      },
    };
  }
}
