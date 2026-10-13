// backend/src/observability/bypass.ts —— X-Compare-Bypass 守卫：仅管理员、白名单、限速、审计（总纲 §8.3）
//
// 1. 仅管理员：非管理员携带该头返回 403 BYPASS_FORBIDDEN（不静默忽略）；X-Experiment-* 头同样只对管理员生效。
// 2. 总开关：运行时配置 labBypassEnabled（ConfigPort，可热关闭）。
// 3. 白名单：每个键只在下表列出的路由上有效；未知键或不允许的组合返回 400。
// 4. 限速与并发：每个管理员每分钟最多 120 个旁路请求（CachePort.incr；拿不到时退回进程内计数），每实例同时最多 4 个在途。
// 5. 不污染缓存：旁路响应一律 Cache-Control: private, no-store。
// 6. 可审计：每个旁路请求经 audit 回调写入 audit_log（谁、哪些键、哪个路由、runId）。
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { BYPASS_KEYS, HEADERS, isBypassKey, type BypassKey } from '@cloudalbum/contracts';
import type { CachePort } from '../ports/cache.js';
import { DEFAULT_RUNTIME_CONFIG, type RuntimeConfig } from '../ports/config.js';
import { currentContext } from './request-context.js';

interface RouteRule { method: string | '*'; pattern: RegExp }

/** 每个旁路键允许的路由（§8.3 表） */
export const BYPASS_ROUTES: Readonly<Record<BypassKey, readonly RouteRule[]>> = {
  cache: [{ method: 'GET', pattern: /^\/api\/feed\/?$/ }, { method: 'GET', pattern: /^\/api\/albums(\/.*)?$/ }],
  cdn: [{ method: 'GET', pattern: /^\/api\/(feed|albums|photos|shares?)(\/.*)?$/ }],
  queue: [{ method: 'POST', pattern: /^\/api\/photos\/[^/]+\/complete$/ }, { method: 'POST', pattern: /^\/social\/photos\/[^/]+\/comments$/ }],
  image: [{ method: 'POST', pattern: /^\/api\/photos\/[^/]+\/complete$/ }],
  tagger: [{ method: 'POST', pattern: /^\/api\/lab\/tagger\/analyze$/ }],
  tracing: [{ method: '*', pattern: /.*/ }],
  analytics: [{ method: '*', pattern: /.*/ }],
  replica: [{ method: 'GET', pattern: /^\/api\/feed\/?$/ }, { method: 'GET', pattern: /^\/api\/albums(\/.*)?$/ }],
  kms: [{ method: 'GET', pattern: /^\/api\/photos\/[^/]+$/ }],
  'identity-pool': [{ method: 'POST', pattern: /^\/api\/uploads\/session$/ }],
};

export function isBypassAllowed(key: BypassKey, method: string, path: string): boolean {
  return BYPASS_ROUTES[key].some((r) => (r.method === '*' || r.method === method.toUpperCase()) && r.pattern.test(path));
}

export function parseBypassHeader(raw: string | string[] | undefined): string[] {
  if (!raw) return [];
  const s = Array.isArray(raw) ? raw.join(',') : raw;
  return [...new Set(s.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean))];
}

export interface BypassAuditEntry { userId?: string; email?: string; keys: BypassKey[]; method: string; route: string; runId?: string }

/** 已登记的实验运行（PM-40 的归属条件：时间窗与标签） */
export interface RegisteredRun { label: string; startedAt: string; windowSec?: number | null; finishedAt?: string | null }

/** 平台模式下忽略的未登记 / 过期 / 标签不符的 X-Experiment-Run（cloudalbum_lab_unregistered_run_header_total） */
export const unregisteredRunHeaders = { total: 0 };

/** 归属的宽限（秒）与未声明时间窗时的缺省窗口（秒） */
export const RUN_GRACE_SEC = 120;
export const DEFAULT_RUN_WINDOW_SEC = 3600;

/** PM-40：当前时间是否在登记的时间窗内（加 120 秒宽限），且标签一致 */
export function runAttributable(run: RegisteredRun, label: string, now = Date.now()): boolean {
  if (!label || run.label !== label) return false;
  const start = Date.parse(run.startedAt);
  if (!Number.isFinite(start)) return false;
  const end = run.windowSec ? start + run.windowSec * 1000 : run.finishedAt ? Date.parse(run.finishedAt) : start + DEFAULT_RUN_WINDOW_SEC * 1000;
  return now >= start - RUN_GRACE_SEC * 1000 && now <= end + RUN_GRACE_SEC * 1000;
}

export interface BypassGuardOptions {
  runtime: () => RuntimeConfig;
  /**
   * ATL 平台模式（06 PM-40）：非管理员请求的 X-Experiment-Run 按“已登记、在时间窗内、标签一致”归属，不要求管理员身份；
   * 不满足时忽略该头（按普通流量统计）。缺省（独立模式）时 X-Experiment-* 只对管理员有效（总纲 7.3、8.3）。
   */
  experimentLookup?: () => ((runId: string) => Promise<RegisteredRun | null>) | undefined;
  cache?: () => CachePort | undefined;
  audit?: (entry: BypassAuditEntry) => Promise<void> | void;
  perMinute?: number;
  maxInFlight?: number;
}

function reject(res: Response, status: number, code: string, message: string): void {
  res.status(status).set('Cache-Control', 'private, no-store').json({ error: code, message });
}

/**
 * 必须挂在认证中间件之后（需要 ctx.isAdmin）。
 */
export function bypassGuard(opts: BypassGuardOptions): RequestHandler {
  const perMinute = opts.perMinute ?? 120;
  const maxInFlight = opts.maxInFlight ?? 4;
  let inFlight = 0;
  const localCounts = new Map<string, { minute: number; count: number }>();

  const countLocal = (who: string): number => {
    const minute = Math.floor(Date.now() / 60_000);
    const cur = localCounts.get(who);
    if (!cur || cur.minute !== minute) {
      localCounts.set(who, { minute, count: 1 });
      return 1;
    }
    cur.count += 1;
    return cur.count;
  };

  return async (req: Request, res: Response, next: NextFunction) => {
    const ctx = currentContext();
    const keys = parseBypassHeader(req.headers[HEADERS.compareBypass.toLowerCase()]);
    const hasExperiment = Boolean(req.headers[HEADERS.experimentRun.toLowerCase()] || req.headers[HEADERS.experimentLabel.toLowerCase()]);
    if (!keys.length && !hasExperiment) return next();

    if (!ctx?.isAdmin) {
      const lookup = !keys.length ? opts.experimentLookup?.() : undefined;
      if (ctx && lookup) {
        // 平台模式：X-Experiment-* 只影响指标分组、不授予任何权限（PM-40）
        const runId = String(req.headers[HEADERS.experimentRun.toLowerCase()] ?? '').trim().toUpperCase();
        const label = String(req.headers[HEADERS.experimentLabel.toLowerCase()] ?? '').trim();
        let run: RegisteredRun | null = null;
        if (/^[0-9A-HJKMNP-TV-Z]{26}$/.test(runId)) run = await lookup(runId).catch(() => null);
        if (run && runAttributable(run, label)) ctx.experiment = { runId, label };
        else unregisteredRunHeaders.total += 1;
        return next();
      }
      return reject(res, 403, keys.length ? 'BYPASS_FORBIDDEN' : 'EXPERIMENT_FORBIDDEN',
        'X-Compare-Bypass / X-Experiment-* 只对管理员有效');
    }
    if (hasExperiment) {
      const runId = String(req.headers[HEADERS.experimentRun.toLowerCase()] ?? '').slice(0, 64);
      const label = String(req.headers[HEADERS.experimentLabel.toLowerCase()] ?? '').slice(0, 64);
      if (runId) ctx.experiment = { runId, ...(label ? { label } : {}) };
    }
    if (!keys.length) return next();

    let runtime: RuntimeConfig;
    try {
      runtime = opts.runtime();
    } catch {
      runtime = DEFAULT_RUNTIME_CONFIG;
    }
    if (!runtime.labBypassEnabled) return reject(res, 403, 'BYPASS_DISABLED', '运行时配置 labBypassEnabled=false');

    const unknown = keys.filter((k) => !isBypassKey(k));
    if (unknown.length) {
      return reject(res, 400, 'BYPASS_UNKNOWN_KEY', `未知的旁路键：${unknown.join(', ')}（允许：${BYPASS_KEYS.join(', ')}）`);
    }
    const valid = keys as BypassKey[];
    const notAllowed = valid.filter((k) => !isBypassAllowed(k, req.method, req.path));
    if (notAllowed.length) {
      return reject(res, 400, 'BYPASS_NOT_ALLOWED', `旁路键 ${notAllowed.join(', ')} 不能用于 ${req.method} ${req.path}`);
    }

    const who = ctx.userId ?? ctx.principal?.subject ?? 'admin';
    let count: number;
    try {
      const cache = opts.cache?.();
      count = cache ? await cache.incr(`bypass:${who}:${Math.floor(Date.now() / 60_000)}`, 120) : countLocal(who);
    } catch {
      count = countLocal(who);
    }
    if (count > perMinute) return reject(res, 429, 'BYPASS_RATE_LIMITED', `每个管理员每分钟最多 ${perMinute} 个旁路请求`);
    if (inFlight >= maxInFlight) return reject(res, 429, 'BYPASS_CONCURRENCY', `每实例同时最多 ${maxInFlight} 个旁路请求在途`);

    inFlight += 1;
    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        inFlight -= 1;
      }
    };
    res.on('finish', release);
    res.on('close', release);

    for (const k of valid) ctx.bypass.add(k);
    res.set(HEADERS.bypass, valid.join(','));
    res.set('Cache-Control', 'private, no-store');
    try {
      await opts.audit?.({
        ...(ctx.userId ? { userId: ctx.userId } : {}),
        ...(ctx.principal?.email ? { email: ctx.principal.email } : {}),
        keys: valid, method: req.method, route: req.path,
        ...(ctx.experiment ? { runId: ctx.experiment.runId } : {}),
      });
    } catch {
      /* 审计写入失败不阻断实验请求，由审计实现自行记录 */
    }
    return next();
  };
}
