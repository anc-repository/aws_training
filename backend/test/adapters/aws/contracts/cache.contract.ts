// CachePort 端口契约（与驱动无关）：none 只需满足“透传”，memory / redis 还要满足“存取”与 single-flight。
import { describe, expect, it } from 'vitest';
import { createRequestContext, runWithContext } from '../../../../src/observability/request-context.js';
import type { CachePort } from '../../../../src/ports/cache.js';

export interface CacheContractHarness {
  create(): Promise<CachePort>;
  /** none 驱动为 false：get 永远 none，wrap 每次都调用 loader */
  stores: boolean;
  /** 每个用例使用不同的键前缀，避免与真实 Redis 中的旧数据冲突 */
  keyPrefix?: () => string;
}

export function describeCachePortContract(name: string, h: CacheContractHarness): void {
  const k = (s: string) => `${h.keyPrefix?.() ?? ''}${s}`;
  describe(`CachePort 契约：${name}`, () => {
    it('get 未命中；set 后命中并返回同一个值（JSON 往返）', async () => {
      const c = await h.create();
      const miss = await c.get(k('photo:1'));
      expect(miss.value).toBeUndefined();
      expect(miss.outcome).toBe(h.stores ? 'miss' : 'none');
      await c.set(k('photo:1'), { id: '1', tags: ['a'], n: 3 }, 60);
      const hit = await c.get<{ id: string; tags: string[]; n: number }>(k('photo:1'));
      if (h.stores) expect(hit).toEqual({ value: { id: '1', tags: ['a'], n: 3 }, outcome: 'hit' });
      else expect(hit.outcome).toBe('none');
    });

    it('del 之后不再命中', async () => {
      const c = await h.create();
      await c.set(k('a'), 1, 60);
      await c.set(k('b'), 2, 60);
      await c.del([k('a'), k('b')]);
      expect((await c.get(k('a'))).value).toBeUndefined();
      expect((await c.get(k('b'))).value).toBeUndefined();
    });

    it('wrap：未命中调用 loader 并回填，之后命中不再调用', async () => {
      const c = await h.create();
      let calls = 0;
      const loader = async () => {
        calls += 1;
        return { page: 1 };
      };
      expect(await c.wrap(k('feed:p1'), 60, loader)).toEqual({ page: 1 });
      expect(await c.wrap(k('feed:p1'), 60, loader)).toEqual({ page: 1 });
      expect(calls).toBe(h.stores ? 1 : 2);
    });

    it('wrap：并发未命中只调用一次 loader（single-flight）', async () => {
      const c = await h.create();
      if (!h.stores) return;
      let calls = 0;
      const loader = async () => {
        calls += 1;
        await new Promise((r) => setTimeout(r, 20));
        return 42;
      };
      const results = await Promise.all(Array.from({ length: 5 }, () => c.wrap(k('sf'), 60, loader)));
      expect(results).toEqual([42, 42, 42, 42, 42]);
      expect(calls).toBe(1);
    });

    it('X-Compare-Bypass: cache → 既不读也不回填', async () => {
      const c = await h.create();
      await c.set(k('bp'), 'cached', 60);
      const ctx = createRequestContext({ isAdmin: true });
      ctx.bypass.add('cache');
      const v = await runWithContext(ctx, () => c.wrap(k('bp'), 60, async () => 'fresh'));
      expect(v).toBe('fresh');
      expect(ctx.path.get('cache')).toMatch(/bypass$|^none$/);
      if (h.stores) expect((await c.get(k('bp'))).value).toBe('cached');
    });

    it('incr：从 1 开始递增', async () => {
      const c = await h.create();
      expect(await c.incr(k('ver:u1'), 60)).toBe(1);
      expect(await c.incr(k('ver:u1'), 60)).toBe(2);
      expect(await c.incr(k('ver:u1'), 60)).toBe(3);
    });
  });
}
