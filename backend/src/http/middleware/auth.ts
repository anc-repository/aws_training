// backend/src/http/middleware/auth.ts —— 认证：BFF + HttpOnly Cookie（ca_at）或 Authorization: Bearer
//
// 只“识别”当前用户（把 Principal 放进请求上下文），不拒绝请求；需要登录的路由用 requireAuth。
// 内部用户 ID：local 模式下 Principal.subject 就是 users.id；cognito 模式由 UserDirectory.ensureUser()（JIT 建档）映射——
// 由 auth 实现者在这里接入（目前先用 subject 占位）。
import type { RequestHandler } from 'express';
import type { Container } from '../../container.js';
import { isNotImplemented } from '../../errors.js';
import { currentContext } from '../../observability/request-context.js';

export const ACCESS_COOKIE = 'ca_at';
export const REFRESH_COOKIE = 'ca_rt';
export const ID_TOKEN_COOKIE = 'ca_it';

export function extractAccessToken(headers: { authorization?: string | undefined }, cookies: Record<string, string> | undefined): string | null {
  const h = headers.authorization;
  if (h && /^Bearer\s+/i.test(h)) return h.replace(/^Bearer\s+/i, '').trim() || null;
  return cookies?.[ACCESS_COOKIE] || null;
}

export function authenticate(c: Container): RequestHandler {
  return async (req, _res, next) => {
    const ctx = currentContext();
    const token = extractAccessToken(req.headers, req.cookies as Record<string, string> | undefined);
    if (!ctx || !token) return next();
    try {
      const principal = await c.auth.verifyAccessToken(token);
      ctx.principal = principal;
      ctx.userId = principal.subject;
      ctx.isAdmin = principal.groups.includes('admin');
    } catch (e) {
      ctx.locals.authError = isNotImplemented(e) ? 'auth-not-implemented' : 'invalid-token';
    }
    next();
  };
}

/** 需要登录：未登录返回 401 */
export const requireAuth: RequestHandler = (_req, res, next) => {
  const ctx = currentContext();
  if (!ctx?.principal) {
    res.status(401).json({ error: 'UNAUTHENTICATED', message: '需要登录' });
    return;
  }
  next();
};
