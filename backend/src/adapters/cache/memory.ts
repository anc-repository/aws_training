// backend/src/adapters/cache/memory.ts —— CachePort 的 `memory` 驱动（本地实现）
// 本地档：进程内 LRU（CACHE_MEMORY_MAX_ITEMS）
// 脚手架桩：方法抛出 NotImplementedError（HTTP 层映射为 501）。由「cache 模块实现者（本地档）」填充。
import type { AdapterDeps } from '../types.js';
import type { AdapterMeta, ProbeResult } from '../../ports/common.js';
import type { CacheOutcome, CachePort } from '../../ports/cache.js';
import { notImplemented } from '../../errors.js';

export class MemoryCache implements CachePort {
  readonly meta: AdapterMeta = { module: 'cache', driver: 'memory', awsService: null, authoritative: false };

  constructor(protected readonly deps: AdapterDeps) {}

  async probe(_opts?: { deep?: boolean }): Promise<ProbeResult> {
    throw notImplemented('MemoryCache', 'probe', 'cache');
  }

  async get<T>(_key: string): Promise<{ value?: T; outcome: CacheOutcome }> {
    throw notImplemented('MemoryCache', 'get', 'cache');
  }

  async set<T>(_key: string, _value: T, _ttlSec: number): Promise<void> {
    throw notImplemented('MemoryCache', 'set', 'cache');
  }

  async del(_keys: string[]): Promise<void> {
    throw notImplemented('MemoryCache', 'del', 'cache');
  }

  async wrap<T>(_key: string, _ttlSec: number, _loader: () => Promise<T>): Promise<T> {
    throw notImplemented('MemoryCache', 'wrap', 'cache');
  }

  async incr(_key: string, _ttlSec: number): Promise<number> {
    throw notImplemented('MemoryCache', 'incr', 'cache');
  }
}
