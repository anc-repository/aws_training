// backend/src/http/middleware/rate-limit.ts —— 应用层限速（计数存在 CachePort.incr：none / memory 为进程内计数，
// 多实例下不准确，见 ASG-013；cache=redis 时全集群共享）。Nginx 的 limit_req 是第一道限速（waf 基线）。
import type { Request, RequestHandler } from 'express';
import type { Container } from '../../container.js';
import { currentContext } from '../../observability/request-context.js';

export interface RateLimitOptions {
  name: string;
  windowSec: number;
  max: number;
  key?: (req: Request) => string;
}

export function rateLimit(c: Container, opts: RateLimitOptions): RequestHandler {
  const local = new Map<string, { window: number; count: number }>();
  const countLocal = (k: string, window: number) => {
    const cur = local.get(k);
    if (!cur || cur.window !== window) {
      local.set(k, { window, count: 1 });
      return 1;
    }
    cur.count += 1;
    return cur.count;
  };
  return async (req, res, next) => {
    const who = opts.key?.(req) ?? currentContext()?.userId ?? req.ip ?? 'anonymous';
    const window = Math.floor(Date.now() / (opts.windowSec * 1000));
    const key = `rl:${opts.name}:${who}:${window}`;
    let count: number;
    try {
      count = await c.cache.incr(key, opts.windowSec);
    } catch {
      count = countLocal(key, window);
    }
    if (count > opts.max) {
      res.status(429).set('Retry-After', String(opts.windowSec)).json({ error: 'RATE_LIMITED', message: `每 ${opts.windowSec} 秒最多 ${opts.max} 次` });
      return;
    }
    next();
  };
}
