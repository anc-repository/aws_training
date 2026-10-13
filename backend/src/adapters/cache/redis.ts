// backend/src/adapters/cache/redis.ts —— CachePort 的 `redis` 驱动（Amazon ElastiCache）
// ioredis；ElastiCache 或 EC2 自建 Valkey（回环地址 = redis@local）；故障按未命中处理（error-bypass）
// 脚手架桩：方法抛出 NotImplementedError（HTTP 层映射为 501）。由「cache 模块实现者」填充。
import type { AdapterDeps } from '../types.js';
import type { AdapterMeta, ProbeResult } from '../../ports/common.js';
import type { CacheOutcome, CachePort } from '../../ports/cache.js';
import { notImplemented } from '../../errors.js';

export class RedisCache implements CachePort {
  readonly meta: AdapterMeta = { module: 'cache', driver: 'redis', awsService: 'Amazon ElastiCache', authoritative: false };

  constructor(protected readonly deps: AdapterDeps) {}

  async probe(_opts?: { deep?: boolean }): Promise<ProbeResult> {
    throw notImplemented('RedisCache', 'probe', 'cache');
  }

  async get<T>(_key: string): Promise<{ value?: T; outcome: CacheOutcome }> {
    throw notImplemented('RedisCache', 'get', 'cache');
  }

  async set<T>(_key: string, _value: T, _ttlSec: number): Promise<void> {
    throw notImplemented('RedisCache', 'set', 'cache');
  }

  async del(_keys: string[]): Promise<void> {
    throw notImplemented('RedisCache', 'del', 'cache');
  }

  async wrap<T>(_key: string, _ttlSec: number, _loader: () => Promise<T>): Promise<T> {
    throw notImplemented('RedisCache', 'wrap', 'cache');
  }

  async incr(_key: string, _ttlSec: number): Promise<number> {
    throw notImplemented('RedisCache', 'incr', 'cache');
  }
}
