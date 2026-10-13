// backend/src/adapters/cache/memory.ts —— CachePort 的 `memory` 驱动（本地档：进程内 LRU，上限 CACHE_MEMORY_MAX_ITEMS）
//
// - 每个 Node 进程各有一份，互不共享，进程重启即清空（LB_LOCAL_WORKERS=2 时就是“多实例不一致”的单机预演）；
// - 值以 JSON 保存（与 redis 驱动语义一致：取出的是副本，调用方修改不会污染缓存）；每个条目有自己的 TTL；
// - wrap：管理员 X-Compare-Bypass: cache 时既不读也不回填（memory:bypass）；未命中时进程内 single-flight；
//   get / set 的耗时由 wrap 自行用 addTiming 记录（instrument 代理不计 wrap 本身）；
// - incr：与普通键共用存储（版本号键 ver:{…} 可以用 get 读出），TTL 只在键创建时设置（INCR + EXPIRE NX 语义）。
import { performance } from 'node:perf_hooks';
import type { AdapterDeps } from '../types.js';
import type { AdapterMeta, ProbeResult } from '../../ports/common.js';
import type { CacheOutcome, CachePort } from '../../ports/cache.js';
import { addTiming, isBypassed, markPath } from '../../observability/request-context.js';

interface Entry { json: string; expiresAt: number }

export class MemoryCache implements CachePort {
  readonly meta: AdapterMeta = { module: 'cache', driver: 'memory', awsService: null, authoritative: false };
  private readonly store = new Map<string, Entry>();
  private readonly inflight = new Map<string, Promise<unknown>>();
  private readonly maxItems: number;
  private hits = 0;
  private misses = 0;
  private evictions = 0;

  constructor(protected readonly deps: AdapterDeps) {
    const c = deps.cfg.cache;
    this.maxItems = 'CACHE_MEMORY_MAX_ITEMS' in c ? c.CACHE_MEMORY_MAX_ITEMS : 5000;
  }

  async probe(_opts?: { deep?: boolean }): Promise<ProbeResult> {
    const total = this.hits + this.misses;
    const ratio = total ? Math.round((this.hits / total) * 1000) / 10 : null;
    return {
      status: 'ok',
      detail: `进程内 LRU · 条目 ${this.store.size}/${this.maxItems}${ratio === null ? '' : ` · 命中率 ${ratio}%`}（每个进程各一份）`,
      data: { items: this.store.size, maxItems: this.maxItems, hits: this.hits, misses: this.misses, evictions: this.evictions, hitRatio: ratio },
    };
  }

  /** 读取（不改变命中统计之外的状态）；过期条目顺便删除 */
  private read(key: string, now = Date.now()): Entry | undefined {
    const e = this.store.get(key);
    if (!e) return undefined;
    if (e.expiresAt <= now) {
      this.store.delete(key);
      return undefined;
    }
    // LRU：最近使用的移到末尾
    this.store.delete(key);
    this.store.set(key, e);
    return e;
  }

  private write(key: string, json: string, ttlSec: number): void {
    this.store.delete(key);
    this.store.set(key, { json, expiresAt: Date.now() + Math.max(1, ttlSec) * 1000 });
    while (this.store.size > this.maxItems) {
      const oldest = this.store.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.store.delete(oldest);
      this.evictions++;
    }
  }

  async get<T>(key: string): Promise<{ value?: T; outcome: CacheOutcome }> {
    const e = this.read(key);
    if (!e) {
      markPath('cache', 'memory:miss');
      return { outcome: 'miss' };
    }
    markPath('cache', 'memory:hit');
    return { value: JSON.parse(e.json) as T, outcome: 'hit' };
  }

  async set<T>(key: string, value: T, ttlSec: number): Promise<void> {
    if (value === undefined) return;
    this.write(key, JSON.stringify(value), ttlSec);
  }

  async del(keys: string[]): Promise<void> {
    for (const k of keys) this.store.delete(k);
  }

  async wrap<T>(key: string, ttlSec: number, loader: () => Promise<T>): Promise<T> {
    if (isBypassed('cache')) {
      markPath('cache', 'memory:bypass');
      return loader();
    }
    const t0 = performance.now();
    const e = this.read(key);
    if (e) {
      this.hits++;
      addTiming('cache', performance.now() - t0);
      markPath('cache', 'memory:hit');
      return JSON.parse(e.json) as T;
    }
    this.misses++;
    addTiming('cache', performance.now() - t0);
    markPath('cache', 'memory:miss');
    const pending = this.inflight.get(key) as Promise<T> | undefined;
    if (pending) return pending;
    const p = (async () => {
      try {
        const value = await loader();
        const t1 = performance.now();
        if (value !== undefined) this.write(key, JSON.stringify(value), ttlSec);
        addTiming('cache', performance.now() - t1);
        return value;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, p);
    return p;
  }

  async incr(key: string, ttlSec: number): Promise<number> {
    const now = Date.now();
    const e = this.read(key, now);
    const cur = e ? Number(JSON.parse(e.json)) : 0;
    const next = (Number.isFinite(cur) ? cur : 0) + 1;
    if (e) {
      e.json = JSON.stringify(next);                       // 保留原 TTL
    } else {
      this.write(key, JSON.stringify(next), ttlSec);
    }
    return next;
  }

  async close(): Promise<void> {
    this.store.clear();
    this.inflight.clear();
  }
}
