// backend/src/ports/cache.ts （总纲 §4.2，照录）
import type { Adapter } from './common.js';

export type CacheOutcome = 'hit' | 'miss' | 'bypass' | 'none' | 'error-bypass';

export interface CachePort extends Adapter {
  get<T>(key: string): Promise<{ value?: T; outcome: CacheOutcome }>;
  set<T>(key: string, value: T, ttlSec: number): Promise<void>;
  del(keys: string[]): Promise<void>;
  /** cache-aside 的标准入口：自动处理 X-Compare-Bypass，并把 outcome 记入 X-CloudAlbum-Path */
  wrap<T>(key: string, ttlSec: number, loader: () => Promise<T>): Promise<T>;
  /** 限速计数等；none/memory 为进程内计数（多实例下不准确，见规则 ASG-013） */
  incr(key: string, ttlSec: number): Promise<number>;
}
