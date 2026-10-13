// backend/src/http/app.ts —— Express 应用：中间件 + 全部路由文件的注册
//
// 中间件顺序（顺序本身是契约）：
//   1. trust proxy = loopback（客户端 IP 与协议只在 Nginx 解析一次，2.5 约定 1）
//   2. body 解析（JSON，保留 rawBody 供 HMAC 校验）与 cookie 解析——必须在建立请求上下文之前（见 request-context.ts）
//   3. 请求上下文（AsyncLocalStorage）→ 可观测性（X-CloudAlbum-Path / Server-Timing / LabMetricsStore）
//   4. 认证（识别 Principal）→ X-Compare-Bypass / X-Experiment-* 守卫 → 只读窗口 → 请求级故障注入
//   5. 路由（每个 routes/*.ts 导出 register(app, c)）→ 404 → 错误处理（NotImplementedError → 501）
import cookieParser from 'cookie-parser';
import express, { type ErrorRequestHandler, type Express } from 'express';
import type { Container } from '../container.js';
import { AwsCredentialsUnavailableError } from '../adapters/aws/clients.js';
import { HttpError, isNotImplemented, NotImplementedError } from '../errors.js';
import { bypassGuard } from '../observability/bypass.js';
import { FaultInjectedError } from '../observability/faults.js';
import { currentContext } from '../observability/request-context.js';
import { platformMode } from '../platform/mode.js';
import { getRegisteredRun } from '../repositories/lab.js';
import { atlProbe } from './middleware/atl-probe.js';
import { auditBypass } from './middleware/audit.js';
import { authenticate } from './middleware/auth.js';
import { frameAncestors } from './middleware/frame-ancestors.js';
import { observability } from './middleware/observability.js';
import { readOnlyGuard } from './middleware/readonly.js';
import { requestContext } from './middleware/request-context.js';
import * as adminRoutes from './routes/admin.js';
import * as albumRoutes from './routes/albums.js';
import * as authRoutes from './routes/auth.js';
import * as capabilityRoutes from './routes/capabilities.js';
import * as healthRoutes from './routes/health.js';
import * as internalHookRoutes from './routes/internal-hooks.js';
import * as jwksRoutes from './routes/jwks.js';
import * as labModuleRoutes from './routes/lab-modules.js';
import * as labProbeRoutes from './routes/lab-probe.js';
import * as labRoutes from './routes/lab.js';
import * as meRoutes from './routes/me.js';
import * as mediaRoutes from './routes/media.js';
import * as notificationRoutes from './routes/notifications.js';
import * as photoRoutes from './routes/photos.js';
import * as socialRoutes from './routes/social.js';
import * as uploadRoutes from './routes/uploads.js';

declare module 'express-serve-static-core' {
  interface Request {
    /** express.json 的原始请求体（HMAC 回调校验用） */
    rawBody?: Buffer;
  }
}

/** 路由注册顺序：具体路径在前；internal-hooks 最后（它兜住其余 /internal/*）。 */
export const ROUTE_MODULES = [
  healthRoutes, capabilityRoutes, jwksRoutes, authRoutes, meRoutes, albumRoutes, photoRoutes, uploadRoutes,
  mediaRoutes, socialRoutes, notificationRoutes, adminRoutes, labProbeRoutes, labModuleRoutes, labRoutes, internalHookRoutes,
] as const;

/** PM-40：已登记运行的查找（平台模式），5 秒缓存（每个实验请求都要判定） */
function cachedRunLookup(c: Container): (runId: string) => Promise<Awaited<ReturnType<typeof getRegisteredRun>>> {
  const cache = new Map<string, { at: number; v: Awaited<ReturnType<typeof getRegisteredRun>> }>();
  return async (runId) => {
    const hit = cache.get(runId);
    if (hit && Date.now() - hit.at < 5000) return hit.v;
    const v = await getRegisteredRun(c.dbRead, runId);
    if (cache.size > 1000) cache.clear();
    cache.set(runId, { at: Date.now(), v });
    return v;
  };
}

export function createApp(c: Container): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');
  app.set('etag', false);

  app.use(express.json({
    limit: '1mb',
    verify: (req, _res, buf) => { (req as express.Request).rawBody = Buffer.from(buf); },
  }));
  app.use(cookieParser());
  app.use(requestContext());
  app.use(atlProbe(c));                                             // ATL 平台模式：探测主体与探测流量标记（06 PM-09、PM-10）
  app.use(observability(c));
  app.use(frameAncestors());                                        // 平台模式：HTML 响应的 CSP frame-ancestors（06 PM-20）
  app.use(authenticate(c));
  const runLookup = cachedRunLookup(c);
  app.use(bypassGuard({
    runtime: () => c.runtimeConfig(),
    cache: () => c.cache,
    audit: auditBypass(c),                                          // 旁路请求写 audit_log（总纲 8.3 第 6 条）
    experimentLookup: () => (platformMode() ? runLookup : undefined),   // 平台模式的运行归属（06 PM-40）
  }));
  app.use(readOnlyGuard(c));
  app.use((_req, _res, next) => {
    if (!c.runtimeConfig().featureFlags['lab.faults']) return next();
    const decision = c.faults.beforeRequest();
    if (decision?.error) {
      currentContext()?.faults.push(decision.faultId);
      return next(decision.error);
    }
    next();
  });

  for (const m of ROUTE_MODULES) m.register(app, c);

  app.use((req, res) => {
    res.status(404).json({ error: 'NOT_FOUND', path: req.path });
  });

  const onError: ErrorRequestHandler = (err: unknown, req, res, _next) => {
    if (res.headersSent) return;
    if (isNotImplemented(err)) {
      const e = err as NotImplementedError;
      res.status(501).json({ error: 'NOT_IMPLEMENTED', message: e.message, component: e.component, member: e.member, module: e.module });
      return;
    }
    if (err instanceof HttpError) {
      if (err.headers) res.set(err.headers);
      res.status(err.status).json({ error: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) });
      return;
    }
    if (err instanceof FaultInjectedError) {
      res.status(503).json({ error: err.code, message: err.message, faultId: err.faultId });
      return;
    }
    if (err instanceof AwsCredentialsUnavailableError) {
      res.status(503).json({ error: err.code, message: err.message });
      return;
    }
    const status = (err as { status?: number; statusCode?: number })?.status ?? (err as { statusCode?: number })?.statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      res.status(status).json({ error: 'BAD_REQUEST', message: (err as Error).message });
      return;
    }
    c.logger.error('unhandled error', { error: err as Error, path: req.path, method: req.method });
    res.status(500).json({ error: 'INTERNAL', requestId: currentContext()?.requestId });
  };
  app.use(onError);
  return app;
}
