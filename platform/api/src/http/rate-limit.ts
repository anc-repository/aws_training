/**
 * Application-level per-user rate limits (01 §8.1: console links, terminals, checks and platform actions each have a
 * per-minute cap; 04 §7.5: at most 10 experiment registrations per session per minute). Limits are parameterised
 * through `PlatformConfig.rateLimits` (falling back to the defaults below).
 *
 * Fixed one-minute windows kept in the function container's memory: API Gateway's stage / route throttling is the
 * global guard, this layer only stops one user from hammering an expensive route. Exceeding → `429 RATE_LIMITED`
 * with `Retry-After`.
 */
import { AtlError } from '@atl/shared';

export const RATE_LIMIT_DEFAULTS = {
  consoleLink: 10,
  terminal: 12,
  checkRun: 20,
  /** Assistants run checks with a stricter cap (01 §5.2). */
  checkRunAssistant: 6,
  moduleOp: 5,
  experimentRegister: 10,
  workspaceEvents: 30,
  quote: 30,
} as const;

export type RateBucketName = keyof typeof RATE_LIMIT_DEFAULTS;

interface Window {
  start: number;
  count: number;
}

export class RateLimiter {
  private readonly windows = new Map<string, Window>();

  constructor(private readonly windowMs = 60_000) {}

  /** Count one call; throws `RATE_LIMITED` when `limit` calls already happened in the current window. */
  hit(key: string, limit: number, nowMs: number): void {
    if (limit <= 0) return;
    const w = this.windows.get(key);
    if (!w || nowMs - w.start >= this.windowMs) {
      this.windows.set(key, { start: nowMs, count: 1 });
      this.gc(nowMs);
      return;
    }
    if (w.count >= limit) {
      const retryAfterSeconds = Math.max(1, Math.ceil((w.start + this.windowMs - nowMs) / 1000));
      throw new AtlError('RATE_LIMITED', `too many requests (${limit} per minute)`, { retryAfterSeconds });
    }
    w.count++;
  }

  private gc(nowMs: number): void {
    if (this.windows.size < 1000) return;
    for (const [k, w] of this.windows) if (nowMs - w.start >= this.windowMs) this.windows.delete(k);
  }
}

/** Effective limit: `PlatformConfig.rateLimits[name]` when it is a non-negative integer, else the default. */
export function rateLimitOf(name: RateBucketName, config: Record<string, unknown> | null | undefined): number {
  const v = (config?.rateLimits as Record<string, unknown> | undefined)?.[name];
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : RATE_LIMIT_DEFAULTS[name];
}

/** One limiter per function container. */
export const sharedRateLimiter = new RateLimiter();
