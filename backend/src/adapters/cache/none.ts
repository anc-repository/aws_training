// backend/src/adapters/cache/none.ts —— CachePort 的 `none` 驱动（本地实现）
// 不缓存：wrap() 直接调用 loader，outcome=none；incr() 为进程内计数
// 脚手架桩：方法抛出 NotImplementedError（HTTP 层映射为 501）。由「L0 本地实现者（本地档由 cache 模块实现者负责）」填充。
import type { AdapterDeps } from '../types.js';
import type { AdapterMeta, ProbeResult } from '../../ports/common.js';
import type { CacheOutcome, CachePort } from '../../ports/cache.js';
import { notImplemented } from '../../errors.js';

export class NoCache implements CachePort {
  readonly meta: AdapterMeta = { module: 'cache', driver: 'none', awsService: null, authoritative: false };

  constructor(protected readonly deps: AdapterDeps) {}

  async probe(_opts?: { deep?: boolean }): Promise<ProbeResult> {
    throw notImplemented('NoCache', 'probe', 'cache');
  }

  async get<T>(_key: string): Promise<{ value?: T; outcome: CacheOutcome }> {
    throw notImplemented('NoCache', 'get', 'cache');
  }

  async set<T>(_key: string, _value: T, _ttlSec: number): Promise<void> {
    throw notImplemented('NoCache', 'set', 'cache');
  }

  async del(_keys: string[]): Promise<void> {
    throw notImplemented('NoCache', 'del', 'cache');
  }

  async wrap<T>(_key: string, _ttlSec: number, _loader: () => Promise<T>): Promise<T> {
    throw notImplemented('NoCache', 'wrap', 'cache');
  }

  async incr(_key: string, _ttlSec: number): Promise<number> {
    throw notImplemented('NoCache', 'incr', 'cache');
  }
}
