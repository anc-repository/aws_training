// backend/src/http/middleware/observability.ts —— 写出 X-CloudAlbum-Path / Server-Timing，并把请求记入 LabMetricsStore（§7）
//
// 头部在“即将写出响应头”的时刻（writeHead）生成，这时本次请求调用过的端口已经全部记在请求上下文里。
// 可见性由 EXPOSE_PATH_HEADERS=all|admin|off 控制；两个头都写入 LabMetricsStore，不受可见性开关影响。
import type { Request, RequestHandler } from 'express';
import { HEADERS } from '@cloudalbum/contracts';
import { performance } from 'node:perf_hooks';
import type { Container } from '../../container.js';
import { buildPathHeader, buildPathSignature } from '../../observability/path-header.js';
import { currentContext, type RequestContext } from '../../observability/request-context.js';
import { buildServerTimingHeader } from '../../observability/server-timing.js';

const ID_SEGMENT = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9A-HJKMNP-TV-Z]{26}|\d+|[0-9a-f]{24,})$/i;

/** 路由模板：路由层设置的 ctx.route 优先；否则 Express 的 baseUrl + route.path；再否则把像 ID 的路径段替换为 :id */
export function routeTemplate(req: Request, ctx?: RequestContext): string {
  if (ctx?.route) return ctx.route;
  const routePath = (req.route as { path?: unknown } | undefined)?.path;
  if (typeof routePath === 'string' && !routePath.includes('*')) return `${req.baseUrl}${routePath}`;
  const segs = req.path.split('/').map((s) => (ID_SEGMENT.test(s) ? ':id' : s));
  return segs.slice(0, 6).join('/') || '/';
}

function origins(...urls: string[]): string[] {
  const out = new Set<string>();
  for (const u of urls) {
    if (!u) continue;
    try {
      out.add(new URL(u).origin);
    } catch {
      /* ignore */
    }
  }
  return [...out];
}

export function observability(c: Container): RequestHandler {
  const tao = origins(c.config.core.APP_BASE_URL, c.config.core.CDN_BASE_URL).join(', ');
  const expose = c.config.core.EXPOSE_PATH_HEADERS;
  return (req, res, next) => {
    const ctx = currentContext();
    if (!ctx) return next();

    // 被动感知：每个请求调用一次（只能做 O(1) 计数）
    for (const det of c.detectors) {
      try {
        det.observe?.({ headers: req.headers, remoteAddr: req.socket.remoteAddress ?? '' });
      } catch {
        /* ignore */
      }
    }

    const original = res.writeHead;
    let applied = false;
    const apply = () => {
      if (applied) return;
      applied = true;
      const visible = expose === 'all' || (expose === 'admin' && ctx.isAdmin);
      if (visible && !res.headersSent) {
        res.setHeader(HEADERS.path, buildPathHeader(ctx));
        res.setHeader(HEADERS.serverTiming, buildServerTimingHeader(ctx));
        if (tao) res.setHeader(HEADERS.timingAllowOrigin, tao);
      }
    };
    res.writeHead = function writeHead(this: typeof res, ...args: unknown[]) {
      apply();
      return (original as (...a: unknown[]) => typeof res).apply(this, args);
    } as typeof res.writeHead;

    res.on('finish', () => {
      const totalMs = performance.now() - ctx.startedAt;
      const modules: Record<string, number> = {};
      for (const t of ctx.timing.entries()) modules[t.module] = Math.round(t.dur * 10) / 10;
      c.labMetrics.recordRequest({
        ts: ctx.startedAtIso,
        requestId: ctx.requestId,
        method: req.method,
        route: routeTemplate(req, ctx),
        status: res.statusCode,
        totalMs,
        path: buildPathHeader(ctx),
        pathSig: buildPathSignature(ctx),
        modules,
        ...(ctx.bypass.size ? { bypass: [...ctx.bypass] } : {}),
        ...(ctx.experiment ? { runId: ctx.experiment.runId, ...(ctx.experiment.label ? { label: ctx.experiment.label } : {}) } : {}),
      });
    });
    next();
  };
}
