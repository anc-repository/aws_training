// backend/src/adapters/cache/none.ts —— CachePort 的 `none` 驱动（本地实现，L0 默认）
// 不缓存：get 永远 outcome=none，set 丢弃，wrap 直接调用 loader；incr 为进程内计数（限速、版本号；多实例下不准确，ASG-013）。
import type { AdapterDeps } from '../types.js';
import type { AdapterMeta, ProbeResult } from '../../ports/common.js';
import type { CacheOutcome, CachePort } from '../../ports/cache.js';
import { isBypassed, markPath } from '../../observability/request-context.js';

/** 进程内的带过期计数器（none 与 memory 驱动共用） */
export class LocalCounters {
  private readonly counters = new Map<string, { value: number; expiresAt: number }>();
  private ops = 0;

  incr(key: string, ttlSec: number, now = Date.now()): number {
    if (++this.ops % 1000 === 0) this.sweep(now);
    const cur = this.counters.get(key);
    if (!cur || cur.expiresAt <= now) {
      this.counters.set(key, { value: 1, expiresAt: now + Math.max(1, ttlSec) * 1000 });
      return 1;
    }
    cur.value += 1;
    return cur.value;
  }

  get(key: string, now = Date.now()): number | undefined {
    const cur = this.counters.get(key);
    return cur && cur.expiresAt > now ? cur.value : undefined;
  }

  delete(key: string): void {
    this.counters.delete(key);
  }

  get size(): number {
    return this.counters.size;
  }

  private sweep(now: number): void {
    for (const [k, v] of this.counters) if (v.expiresAt <= now) this.counters.delete(k);
  }
}

export class NoCache implements CachePort {
  readonly meta: AdapterMeta = { module: 'cache', driver: 'none', awsService: null, authoritative: false };
  private readonly counters = new LocalCounters();

  constructor(protected readonly deps: AdapterDeps) {}

  async probe(_opts?: { deep?: boolean }): Promise<ProbeResult> {
    return { status: 'ok', detail: '不缓存：每次请求都查数据库（CACHE_DRIVER=none）', data: { counters: this.counters.size } };
  }

  async get<T>(_key: string): Promise<{ value?: T; outcome: CacheOutcome }> {
    markPath('cache', 'none');
    return { outcome: 'none' };
  }

  async set<T>(_key: string, _value: T, _ttlSec: number): Promise<void> {
    /* 不缓存 */
  }

  async del(_keys: string[]): Promise<void> {
    /* 不缓存 */
  }

  async wrap<T>(_key: string, _ttlSec: number, loader: () => Promise<T>): Promise<T> {
    markPath('cache', isBypassed('cache') ? 'none:bypass' : 'none');
    return loader();
  }

  async incr(key: string, ttlSec: number): Promise<number> {
    return this.counters.incr(key, ttlSec);
  }
}
