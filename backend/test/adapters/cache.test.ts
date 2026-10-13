// CachePort 契约测试：none 与 memory（本地档）。旁路、single-flight、LRU、TTL、版本号计数
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryCache } from '../../src/adapters/cache/memory.js';
import { LocalCounters, NoCache } from '../../src/adapters/cache/none.js';
import { createRequestContext, runWithContext } from '../../src/observability/request-context.js';
import type { CachePort } from '../../src/ports/cache.js';
import { adapterDeps, testConfig } from '../helpers/media-fixtures.js';

afterEach(() => {
  vi.useRealTimers();
});

/** 所有 CachePort 驱动共有的行为（redis 驱动的实现者可以复用） */
export function cacheContract(name: string, make: () => CachePort, caches: boolean): void {
  describe(`CachePort 契约：${name}`, () => {
    it('wrap 返回 loader 的值；第二次是否命中取决于驱动', async () => {
      const c = make();
      const loader = vi.fn(async () => ({ n: 1 }));
      expect(await c.wrap('k1', 60, loader)).toEqual({ n: 1 });
      expect(await c.wrap('k1', 60, loader)).toEqual({ n: 1 });
      expect(loader).toHaveBeenCalledTimes(caches ? 1 : 2);
    });

    it('X-Compare-Bypass: cache 时既不读也不回填，路径头记为 bypass', async () => {
      const c = make();
      await c.wrap('k2', 60, async () => 'cached');
      const ctx = createRequestContext();
      ctx.bypass.add('cache');
      const loader = vi.fn(async () => 'fresh');
      const v = await runWithContext(ctx, () => c.wrap('k2', 60, loader));
      expect(v).toBe('fresh');
      expect(loader).toHaveBeenCalledTimes(1);
      expect(ctx.path.get('cache')).toMatch(/:bypass$/);
      // 旁路请求没有回填：普通请求仍得到旧值（memory）或重新加载（none）
      const again = await c.wrap('k2', 60, async () => 'other');
      expect(again).toBe(caches ? 'cached' : 'other');
    });

    it('incr 单调递增（版本号、限速计数）', async () => {
      const c = make();
      expect(await c.incr('ver:{u:1}', 60)).toBe(1);
      expect(await c.incr('ver:{u:1}', 60)).toBe(2);
      expect(await c.incr('ver:{u:2}', 60)).toBe(1);
    });

    it('get / set / del', async () => {
      const c = make();
      await c.set('k3', { a: 1 }, 60);
      const r = await c.get<{ a: number }>('k3');
      if (caches) expect(r).toEqual({ value: { a: 1 }, outcome: 'hit' });
      else expect(r).toEqual({ outcome: 'none' });
      await c.del(['k3']);
      expect((await c.get('k3')).value).toBeUndefined();
    });

    it('probe 返回 ok', async () => {
      expect((await make().probe()).status).toBe('ok');
    });
  });
}

const cfg = testConfig({ CACHE_DRIVER: 'memory', CACHE_MEMORY_MAX_ITEMS: '3' });
cacheContract('none', () => new NoCache(adapterDeps(testConfig())), false);
cacheContract('memory', () => new MemoryCache(adapterDeps(cfg)), true);

describe('MemoryCache 细节', () => {
  it('路径头：memory:miss → memory:hit', async () => {
    const c = new MemoryCache(adapterDeps(cfg));
    const ctx1 = createRequestContext();
    await runWithContext(ctx1, () => c.wrap('p', 60, async () => 1));
    expect(ctx1.path.get('cache')).toBe('memory:miss');
    const ctx2 = createRequestContext();
    await runWithContext(ctx2, () => c.wrap('p', 60, async () => 2));
    expect(ctx2.path.get('cache')).toBe('memory:hit');
    expect(ctx2.timing.entries().find((t) => t.module === 'cache')).toBeTruthy();
  });

  it('single-flight：并发未命中只调用一次 loader', async () => {
    const c = new MemoryCache(adapterDeps(cfg));
    let calls = 0;
    const loader = async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 20));
      return calls;
    };
    const results = await Promise.all([c.wrap('sf', 60, loader), c.wrap('sf', 60, loader), c.wrap('sf', 60, loader)]);
    expect(calls).toBe(1);
    expect(results).toEqual([1, 1, 1]);
  });

  it('LRU：超过 CACHE_MEMORY_MAX_ITEMS 时淘汰最久未使用的条目', async () => {
    const c = new MemoryCache(adapterDeps(cfg));
    await c.set('a', 1, 60);
    await c.set('b', 2, 60);
    await c.set('c', 3, 60);
    await c.get('a');                       // a 变成最近使用
    await c.set('d', 4, 60);                // 淘汰 b
    expect((await c.get('b')).outcome).toBe('miss');
    expect((await c.get('a')).value).toBe(1);
    expect((await c.probe()).data?.evictions).toBe(1);
  });

  it('TTL 到期后未命中；incr 只在创建时设置 TTL；值是副本', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const c = new MemoryCache(adapterDeps(cfg));
    const obj = { x: [1] };
    await c.set('t', obj, 10);
    obj.x.push(2);
    expect((await c.get<{ x: number[] }>('t')).value).toEqual({ x: [1] });
    await c.incr('n', 10);
    vi.setSystemTime(new Date('2026-01-01T00:00:08Z'));
    await c.incr('n', 10);
    vi.setSystemTime(new Date('2026-01-01T00:00:11Z'));
    expect((await c.get('t')).outcome).toBe('miss');
    expect(await c.incr('n', 10)).toBe(1);   // 旧计数在第 10 秒过期
  });
});

describe('LocalCounters（none 驱动的限速计数）', () => {
  it('窗口过期后从 1 重新计数', () => {
    const k = new LocalCounters();
    expect(k.incr('x', 1, 1000)).toBe(1);
    expect(k.incr('x', 1, 1500)).toBe(2);
    expect(k.incr('x', 1, 2500)).toBe(1);
    expect(k.get('x', 2600)).toBe(1);
    expect(k.get('x', 9999)).toBeUndefined();
  });
});
