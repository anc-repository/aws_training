// backend/src/http/middleware/readonly.ts —— 只读窗口与维护模式（运行时配置 readOnly / maintenanceMode，总纲 9.3 规则 3）
//
// readOnly：写接口返回 503 与 Retry-After，读接口照常；maintenanceMode：除健康检查与 capabilities 外一律 503。
import type { RequestHandler } from 'express';
import type { Container } from '../../container.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const ALWAYS_ALLOWED = [/^\/api\/health(\/|$)/, /^\/api\/capabilities(\/|$)/, /^\/metrics$/];

export function readOnlyGuard(c: Container): RequestHandler {
  return (req, res, next) => {
    if (ALWAYS_ALLOWED.some((r) => r.test(req.path))) return next();
    const rc = c.runtimeConfig();
    if (rc.maintenanceMode) {
      res.status(503).set('Retry-After', '60').json({ error: 'MAINTENANCE', message: rc.banner ?? '维护中' });
      return;
    }
    if (rc.readOnly && !SAFE_METHODS.has(req.method)) {
      res.status(503).set('Retry-After', '60').json({ error: 'READ_ONLY', message: '数据迁移窗口：暂时只读' });
      return;
    }
    next();
  };
}
