// backend/src/adapters/lock/redis.ts —— 内部 LockPort 的 `redis` 实现（scope=cluster）
// Redis SET NX PX + 带令牌的释放（Lua）；CACHE_DRIVER=redis 时全集群互斥
// 脚手架桩：tryAcquire 抛出 NotImplementedError。由「cache 模块实现者」填充。
import type { Lease, LockPort } from '../../ports/lock.js';
import { notImplemented } from '../../errors.js';
import type { AdapterDeps } from '../types.js';

export class RedisLock implements LockPort {
  readonly driver = 'redis' as const;
  readonly scope = 'cluster' as const;

  constructor(protected readonly deps: AdapterDeps) {}

  async tryAcquire(_name: string, _ttlSec: number): Promise<Lease | null> {
    throw notImplemented('RedisLock', 'tryAcquire');
  }
}
