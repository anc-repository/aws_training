// backend/src/http/middleware/admin.ts —— 管理员守卫（F12：应用层 RBAC，users.role='admin' → Principal.groups 含 admin）
import type { RequestHandler } from 'express';
import { currentContext } from '../../observability/request-context.js';

export const requireAdmin: RequestHandler = (_req, res, next) => {
  const ctx = currentContext();
  if (!ctx?.principal) {
    res.status(401).json({ error: 'UNAUTHENTICATED', message: '需要登录' });
    return;
  }
  if (!ctx.isAdmin) {
    res.status(403).json({ error: 'FORBIDDEN', message: '仅管理员可用' });
    return;
  }
  next();
};
