// backend/src/http/middleware/auth.ts —— 认证：BFF + HttpOnly Cookie（ca_at）或 Authorization: Bearer
//
// 只“识别”当前用户（把 Principal 放进请求上下文），不拒绝匿名请求；需要登录的路由用 requireAuth。另外负责三件事：
// 1. 内部用户 ID：local 模式下 Principal.subject 就是 users.id；cognito 模式由 UserDirectory.ensureUser()（JIT 建档）映射。
// 2. CSRF：以 Cookie 认证的写请求（非 GET/HEAD/OPTIONS）必须同源——检查 Origin（或 Sec-Fetch-Site）；
//    Cookie 本身是 SameSite=Lax，这里再加一道（02#auth 第 1 节“CSRF”），对前端透明，不需要额外的请求头。
// 3. 受限会话：auth=local 注册后、邮箱验证前，只允许 /api/auth/*、/api/me、/api/me/outbox*（04#email /me/outbox），
//    其余 /api/*、/social/* 返回 403 EMAIL_NOT_VERIFIED。
// 另外把客户端 IP 与 User-Agent 放进 ctx.locals（审计记录使用；IP 已由 Nginx realip 解析，Express trust proxy=loopback）。
import type { Request, RequestHandler } from 'express';
import type { Container } from '../../container.js';
import { HttpError, isNotImplemented } from '../../errors.js';
import { currentContext } from '../../observability/request-context.js';
import { UserDirectory } from '../../services/user-directory.js';

export const ACCESS_COOKIE = 'ca_at';
export const REFRESH_COOKIE = 'ca_rt';
export const ID_TOKEN_COOKIE = 'ca_it';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** 未验证邮箱的受限会话可访问的路径 */
export const UNVERIFIED_ALLOWED: readonly RegExp[] = [
  /^\/api\/auth(\/|$)/, /^\/api\/me\/?$/, /^\/api\/me\/outbox(\/|$)/, /^\/api\/capabilities(\/|$)/, /^\/api\/health(\/|$)/,
];

export function extractAccessToken(headers: { authorization?: string | undefined }, cookies: Record<string, string> | undefined): string | null {
  return extractAccessTokenWithSource(headers, cookies)?.token ?? null;
}

export function extractAccessTokenWithSource(headers: { authorization?: string | undefined }, cookies: Record<string, string> | undefined):
  { token: string; source: 'bearer' | 'cookie' } | null {
  const h = headers.authorization;
  if (h && /^Bearer\s+/i.test(h)) {
    const token = h.replace(/^Bearer\s+/i, '').trim();
    return token ? { token, source: 'bearer' } : null;
  }
  const c = cookies?.[ACCESS_COOKIE];
  return c ? { token: c, source: 'cookie' } : null;
}

function originOf(u: string): string | null {
  try {
    return new URL(u).origin.toLowerCase();
  } catch {
    return null;
  }
}

/** 允许的来源：APP_BASE_URL、CDN_BASE_URL，以及请求自身的 Host（同源；开发机经 Vite 代理时 Host 即前端地址） */
export function isSameOriginRequest(req: Request, allowed: ReadonlySet<string>): boolean {
  const site = req.get('sec-fetch-site');
  if (site === 'cross-site') return false;
  const origin = req.get('origin');
  if (!origin || origin === 'null') return site !== 'cross-site' && origin !== 'null';
  const o = originOf(origin);
  if (!o) return false;
  if (allowed.has(o)) return true;
  const host = req.get('host');
  return Boolean(host) && (o === `http://${host}`.toLowerCase() || o === `https://${host}`.toLowerCase());
}

export function isAllowedForUnverified(path: string): boolean {
  return UNVERIFIED_ALLOWED.some((r) => r.test(path));
}

export function authenticate(c: Container): RequestHandler {
  const directory = new UserDirectory(c.db);
  const allowedOrigins = new Set([c.config.core.APP_BASE_URL, c.config.core.CDN_BASE_URL].map((u) => (u ? originOf(u) : null))
    .filter((o): o is string => Boolean(o)));
  return async (req, res, next) => {
    const ctx = currentContext();
    if (!ctx) return next();
    ctx.locals.clientIp = req.ip ?? req.socket.remoteAddress ?? null;
    ctx.locals.userAgent = req.get('user-agent') ?? null;
    const found = extractAccessTokenWithSource(req.headers, req.cookies as Record<string, string> | undefined);
    if (!found) return next();
    if (found.source === 'cookie' && !SAFE_METHODS.has(req.method) && !isSameOriginRequest(req, allowedOrigins)) {
      res.status(403).json({ error: 'CSRF_ORIGIN_MISMATCH', message: '跨站请求被拒绝：以 Cookie 认证的写请求必须来自本站页面' });
      return;
    }
    let principal;
    try {
      principal = await c.auth.verifyAccessToken(found.token);
    } catch (e) {
      ctx.locals.authError = isNotImplemented(e) ? 'auth-not-implemented' : ((e as HttpError).code ?? 'invalid-token');
      return next();
    }
    try {
      ctx.userId = await directory.userIdOf(principal);
    } catch (e) {
      return next(e);
    }
    ctx.principal = principal;
    ctx.isAdmin = principal.groups.includes('admin');
    if (!principal.emailVerified && (req.path.startsWith('/api/') || req.path.startsWith('/social/')) && !isAllowedForUnverified(req.path)) {
      res.status(403).json({ error: 'EMAIL_NOT_VERIFIED', message: '请先完成邮箱验证（验证邮件在 /me/outbox 或你的邮箱里）' });
      return;
    }
    next();
  };
}

/** 需要登录：未登录返回 401（令牌过期时 error=TOKEN_EXPIRED 由前端触发 /api/auth/refresh） */
export const requireAuth: RequestHandler = (_req, res, next) => {
  const ctx = currentContext();
  if (!ctx?.principal) {
    const reason = ctx?.locals.authError;
    res.status(401).json({ error: 'UNAUTHENTICATED', message: '需要登录', ...(typeof reason === 'string' ? { reason } : {}) });
    return;
  }
  next();
};

/** 路由内取当前用户（requireAuth 之后调用） */
export function currentUser(): { userId: string; email: string; isAdmin: boolean; emailVerified: boolean } {
  const ctx = currentContext();
  if (!ctx?.principal || !ctx.userId) throw new HttpError(401, 'UNAUTHENTICATED', '需要登录');
  return { userId: ctx.userId, email: ctx.principal.email, isAdmin: ctx.isAdmin, emailVerified: ctx.principal.emailVerified };
}
