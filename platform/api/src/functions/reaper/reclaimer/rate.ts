/**
 * Per-region token bucket for CloudTrail `LookupEvents` (01 §7.2 RateBucket `PLATFORM / RATE#cloudtrail-lookup#<region>`,
 * AP28): reclaim scans, OwnershipLookup and the checks share it (02 §7.3). The account / region limit is low (documented
 * by AWS as a few requests per second); capacity and refill are parameters, the defaults stay below it.
 */
import { Keys } from '@atl/shared';
import type { Ctx } from '../../lifecycle/context.js';
import { Expr, isConditionFailed } from '../../lifecycle/store/ddb.js';

export const LOOKUP_BUCKET = { capacity: 2, refillPerSecond: 1 } as const;

/** Take one token; returns 0 on success or the seconds to wait. */
export async function takeLookupToken(ctx: Ctx, region: string, cfg: { capacity: number; refillPerSecond: number } = LOOKUP_BUCKET): Promise<number> {
  const key = Keys.rateBucket('cloudtrail-lookup', region);
  for (let attempt = 0; attempt < 5; attempt++) {
    const now = ctx.nowMs();
    const cur = await ctx.main.get(key);
    const ver = typeof cur?.ver === 'number' ? cur.ver : 0;
    const last = typeof cur?.refilledAt === 'string' ? Date.parse(cur.refilledAt) : now;
    const stored = typeof cur?.tokens === 'number' ? cur.tokens : cfg.capacity;
    const tokens = Math.min(cfg.capacity, stored + ((now - last) / 1000) * cfg.refillPerSecond);
    if (tokens < 1) return Math.max(1, Math.ceil((1 - tokens) / cfg.refillPerSecond));
    const e = new Expr();
    const cond = ver === 0 ? `attribute_not_exists(${e.name('PK')})` : `${e.name('ver')} = ${e.value(ver)}`;
    try {
      await ctx.main.put(
        {
          ...key,
          type: 'RateBucket',
          ver: ver + 1,
          createdAt: (cur?.createdAt as string | undefined) ?? new Date(now).toISOString(),
          updatedAt: new Date(now).toISOString(),
          tokens: tokens - 1,
          refilledAt: new Date(now).toISOString(),
          capacity: cfg.capacity,
          refillPerMinute: cfg.refillPerSecond * 60,
        },
        { expr: cond, e },
      );
      return 0;
    } catch (err) {
      if (isConditionFailed(err)) continue;
      throw err;
    }
  }
  return 1;
}

/**
 * Take one token, waiting up to `maxWaitSeconds` in total for the bucket to refill (a synchronous OwnershipLookup or a
 * discovery page issues a few queries in a row). Returns 0, or the remaining seconds when the bucket stays empty.
 */
export async function awaitLookupToken(ctx: Ctx, region: string, maxWaitSeconds = 3): Promise<number> {
  let waited = 0;
  for (;;) {
    const wait = await takeLookupToken(ctx, region);
    if (wait === 0) return 0;
    if (waited + wait > maxWaitSeconds) return wait;
    await ctx.deps.ports.clock.sleep(wait * 1000);
    waited += wait;
  }
}
