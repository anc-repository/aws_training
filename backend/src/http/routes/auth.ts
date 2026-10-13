// backend/src/http/routes/auth.ts —— F1：注册、邮箱验证、登录、MFA、刷新、登出、找回密码、会话（/api/auth/*，Nginx 对其单独 limit_req）
//
// BFF + HttpOnly Cookie（02#auth）：ca_at（access，Path=/）、ca_rt（refresh，Path=/api/auth）、ca_it（ID 令牌，cognito 才有）；
// 都是 HttpOnly + SameSite=Lax，AUTH_COOKIE_SECURE=auto 时 APP_BASE_URL 为 https（或请求经 TLS 到达）才加 Secure。前端 JS 不接触令牌。
// 流程由 AuthPort.flows 提供（local 驱动；cognito 的 sdk 子模式若提供 flows 也走同一组接口）；flows 为 null 时这些接口返回 404。
//
//   POST /api/auth/register        {email,password,displayName} → 201，并签发“未验证”受限会话（可直接打开 /me/outbox 完成验证）
//   POST /api/auth/confirm         {email,code}
//   POST /api/auth/resend          {email?}（受限会话下可省略）→ 204（不论邮箱是否存在，防枚举）
//   POST /api/auth/login           {email,password} → {kind:'tokens',user} | {kind:'mfa_required',challengeId}；401 / 423 / 403
//   POST /api/auth/mfa/verify      {challengeId,code} 完成登录挑战；无 challengeId 时（已登录）确认 MFA 绑定
//   POST /api/auth/mfa/enroll      → {otpauthUrl,secret,qrDataUrl}
//   POST /api/auth/refresh         （ca_rt）→ 轮换后的新 Cookie
//   POST /api/auth/logout          → 204（刷新令牌整族作废 + token_version+1）
//   POST /api/auth/forgot          {email} → 202（防枚举）
//   POST /api/auth/reset           {email,code,newPassword}
//   GET  /api/auth/session         → {authenticated,user,expiresAt}；?for=social 另返回内存中的短期令牌 {token,expiresAt}
//
// /api/me/outbox*（本人邮件预览）的处理器由 registerSelfOutbox() 提供，在 routes/me.ts 中注册（总纲 §11：me.ts 承载 /me/outbox）。
import type { Express, Request, Response } from 'express';
import { z } from 'zod';
import type { Container } from '../../container.js';
import { HttpError } from '../../errors.js';
import { driverOf } from '../../modules/registry.js';
import { markPath } from '../../observability/request-context.js';
import type { EmbeddedAuthFlows, Principal, TokenSet } from '../../ports/auth.js';
import { findOutboxForRecipient, listOutboxForRecipient, type OutboxEmailRow } from '../../repositories/outbox.js';
import { toOutboxSummary } from '../../services/notifications.js';
import { toMe, UserDirectory } from '../../services/user-directory.js';
import { audit } from '../middleware/audit.js';
import { ACCESS_COOKIE, currentUser, ID_TOKEN_COOKIE, REFRESH_COOKIE, requireAuth } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rate-limit.js';
import { currentContext } from '../../observability/request-context.js';

export const REFRESH_COOKIE_PATH = '/api/auth';

const emailField = z.string().trim().min(3).max(320);
const RegisterBody = z.object({ email: emailField, password: z.string().min(1).max(256), displayName: z.string().max(120).optional().default('') });
const LoginBody = z.object({ email: emailField, password: z.string().min(1).max(256) });
const ConfirmBody = z.object({ email: emailField, code: z.string().trim().min(1).max(200) });
const EmailBody = z.object({ email: emailField.optional() });
const ResetBody = z.object({ email: emailField, code: z.string().trim().min(1).max(200), newPassword: z.string().min(1).max(256) });
const MfaVerifyBody = z.object({ challengeId: z.string().max(200).optional(), code: z.string().trim().min(6).max(10) });

export function parseBody<T extends z.ZodType>(schema: T, body: unknown): z.infer<T> {
  const r = schema.safeParse(body ?? {});
  if (!r.success) {
    throw new HttpError(400, 'VALIDATION_FAILED', r.error.issues.map((i) => `${i.path.join('.') || 'body'}：${i.message}`).join('；'),
      { issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
  }
  return r.data;
}

// ------------------------------------------------------------------------------------------------
// Cookie
// ------------------------------------------------------------------------------------------------

export function cookieSecure(c: Container, req: Request): boolean {
  const mode = c.config.auth.AUTH_COOKIE_SECURE;
  if (mode === 'true') return true;
  if (mode === 'false') return false;
  return c.config.core.APP_BASE_URL.startsWith('https://') || req.secure;
}

export function setSessionCookies(c: Container, req: Request, res: Response, tokens: TokenSet): void {
  const base = { httpOnly: true, sameSite: 'lax' as const, secure: cookieSecure(c, req) };
  res.cookie(ACCESS_COOKIE, tokens.accessToken, { ...base, path: '/', maxAge: tokens.expiresIn * 1000 });
  const refreshDays = 'AUTH_REFRESH_TTL_DAYS' in c.config.auth ? c.config.auth.AUTH_REFRESH_TTL_DAYS : 30;
  if (tokens.refreshToken) res.cookie(REFRESH_COOKIE, tokens.refreshToken, { ...base, path: REFRESH_COOKIE_PATH, maxAge: refreshDays * 86_400_000 });
  if (tokens.idToken) res.cookie(ID_TOKEN_COOKIE, tokens.idToken, { ...base, path: '/', maxAge: tokens.expiresIn * 1000 });
}

export function clearSessionCookies(c: Container, req: Request, res: Response): void {
  const base = { httpOnly: true, sameSite: 'lax' as const, secure: cookieSecure(c, req) };
  res.clearCookie(ACCESS_COOKIE, { ...base, path: '/' });
  res.clearCookie(REFRESH_COOKIE, { ...base, path: REFRESH_COOKIE_PATH });
  res.clearCookie(ID_TOKEN_COOKIE, { ...base, path: '/' });
}

function noStore(res: Response): void {
  res.set('Cache-Control', 'no-store');
}

function flowsOf(c: Container): EmbeddedAuthFlows {
  const flows = c.auth.flows;
  if (!flows) {
    throw new HttpError(404, 'AUTH_FLOW_UNAVAILABLE', `当前认证驱动（${driverOf(c.env, 'auth')}）的注册 / 登录不经 EC2 处理，请使用身份提供方的登录页`);
  }
  return flows;
}

function clientKey(req: Request, extra = ''): string {
  return `${req.ip ?? 'unknown'}${extra ? `|${extra.toLowerCase()}` : ''}`;
}

// ------------------------------------------------------------------------------------------------
// 路由
// ------------------------------------------------------------------------------------------------

export function register(app: Express, c: Container): void {
  const directory = new UserDirectory(c.db);
  const emailOf = (req: Request) => (typeof req.body?.email === 'string' ? req.body.email : '');
  const limitLogin = rateLimit(c, { name: 'auth-login', windowSec: 60, max: 20, key: (req) => clientKey(req, emailOf(req)) });
  const limitRegister = rateLimit(c, { name: 'auth-register', windowSec: 600, max: 20, key: (req) => clientKey(req) });
  const limitMail = rateLimit(c, { name: 'auth-mail', windowSec: 900, max: 5, key: (req) => clientKey(req, emailOf(req)) });

  /** 令牌 → Principal → users 行 → 对外的 Me */
  async function sessionUser(tokens: TokenSet): Promise<{ principal: Principal; me: ReturnType<typeof toMe> }> {
    const principal = await c.auth.verifyAccessToken(tokens.accessToken);
    const user = await directory.ensureUser(principal);
    return { principal, me: toMe(user, principal) };
  }

  app.post('/api/auth/register', limitRegister, async (req, res) => {
    noStore(res);
    const flows = flowsOf(c);
    const body = parseBody(RegisterBody, req.body);
    let result: { subject: string; needsConfirmation: boolean };
    try {
      result = await flows.register({ email: body.email, password: body.password, displayName: body.displayName });
    } catch (e) {
      await audit(c, { action: 'user.register', result: 'denied', details: { email: body.email.toLowerCase(), code: (e as HttpError).code ?? 'error' } });
      throw e;
    }
    await audit(c, { action: 'user.register', targetType: 'user', targetId: result.subject, actor: { type: 'user', id: result.subject, email: body.email.toLowerCase() } });
    // 立即登录：未验证邮箱时得到受限会话，用户可以直接打开 /me/outbox 点验证链接（04#email）
    let user: ReturnType<typeof toMe> | undefined;
    try {
      const login = await flows.login(body.email, body.password);
      if (login.kind === 'tokens') {
        setSessionCookies(c, req, res, login.tokens);
        user = (await sessionUser(login.tokens)).me;
      }
    } catch (e) {
      c.logger.warn('auto login after register failed', { error: (e as Error).message });
    }
    const emailDriver = driverOf(c.env, 'email');
    res.status(201).json({
      userId: result.subject,
      needsConfirmation: result.needsConfirmation,
      restrictedSession: Boolean(user && !user.emailVerified),
      ...(user ? { user } : {}),
      verification: {
        transport: emailDriver,
        selfPreview: emailDriver === 'outbox' && c.runtimeConfig().featureFlags['email.selfPreview'] !== false,
        selfPreviewPath: '/me/outbox',
      },
    });
  });

  app.post('/api/auth/confirm', async (req, res) => {
    noStore(res);
    const body = parseBody(ConfirmBody, req.body);
    try {
      await flowsOf(c).confirmRegistration(body.email, body.code);
    } catch (e) {
      await audit(c, { action: 'user.email_verify', result: 'denied', details: { email: body.email.toLowerCase() } });
      throw e;
    }
    await audit(c, { action: 'user.email_verify', targetType: 'user', details: { email: body.email.toLowerCase() } });
    res.json({ ok: true, emailVerified: true });
  });

  app.post('/api/auth/resend', limitMail, async (req, res) => {
    noStore(res);
    const body = parseBody(EmailBody, req.body);
    const email = body.email ?? currentContext()?.principal?.email;
    if (!email) throw new HttpError(400, 'VALIDATION_FAILED', '需要 email');
    await flowsOf(c).resendCode(email);
    res.status(204).end();
  });

  app.post('/api/auth/login', limitLogin, async (req, res) => {
    noStore(res);
    const flows = flowsOf(c);
    const body = parseBody(LoginBody, req.body);
    let result;
    try {
      result = await flows.login(body.email, body.password);
    } catch (e) {
      const err = e as HttpError;
      await audit(c, {
        action: 'user.login_failed', result: 'denied', actor: { type: 'anonymous', email: body.email.toLowerCase() },
        details: { code: err.code ?? 'error' },
      });
      throw e;
    }
    if (result.kind === 'mfa_required') {
      res.json({ kind: 'mfa_required', challengeId: result.challengeId });
      return;
    }
    setSessionCookies(c, req, res, result.tokens);
    const { me } = await sessionUser(result.tokens);
    await audit(c, { action: 'user.login', targetType: 'user', targetId: me.id, actor: { type: me.role === 'admin' ? 'admin' : 'user', id: me.id, email: me.email } });
    res.json({ kind: 'tokens', user: me, expiresIn: result.tokens.expiresIn });
  });

  app.post('/api/auth/mfa/verify', async (req, res) => {
    noStore(res);
    const flows = flowsOf(c);
    const body = parseBody(MfaVerifyBody, req.body);
    if (body.challengeId) {
      const tokens = await flows.completeMfa(body.challengeId, body.code);
      setSessionCookies(c, req, res, tokens);
      const { me } = await sessionUser(tokens);
      await audit(c, { action: 'user.login', targetType: 'user', targetId: me.id, actor: { type: me.role === 'admin' ? 'admin' : 'user', id: me.id, email: me.email }, details: { mfa: true } });
      res.json({ kind: 'tokens', user: me, expiresIn: tokens.expiresIn });
      return;
    }
    const ctx = currentContext();
    if (!ctx?.principal) throw new HttpError(401, 'UNAUTHENTICATED', '需要登录（或提供 challengeId）');
    await flows.verifyTotp(ctx.principal.subject, body.code);
    await audit(c, { action: 'user.mfa_enabled', targetType: 'user', targetId: ctx.userId ?? null });
    res.json({ ok: true, mfaEnabled: true });
  });

  app.post('/api/auth/mfa/enroll', requireAuth, async (_req, res) => {
    noStore(res);
    const ctx = currentContext()!;
    const { otpauthUrl } = await flowsOf(c).setupTotp(ctx.principal!.subject);
    const secret = new URL(otpauthUrl).searchParams.get('secret') ?? undefined;
    let qrDataUrl: string | undefined;
    try {
      const qr = (await import('qrcode')) as unknown as { toDataURL?: (s: string) => Promise<string>; default?: { toDataURL: (s: string) => Promise<string> } };
      qrDataUrl = await (qr.toDataURL ?? qr.default!.toDataURL)(otpauthUrl);
    } catch {
      qrDataUrl = undefined;
    }
    res.json({ otpauthUrl, ...(secret ? { secret } : {}), ...(qrDataUrl ? { qrDataUrl } : {}) });
  });

  app.post('/api/auth/refresh', async (req, res) => {
    noStore(res);
    const flows = flowsOf(c);
    const cookies = req.cookies as Record<string, string> | undefined;
    const rt = cookies?.[REFRESH_COOKIE] ?? (typeof req.body?.refreshToken === 'string' ? req.body.refreshToken : '');
    if (!rt) throw new HttpError(401, 'NO_REFRESH_TOKEN', '没有刷新令牌，请重新登录');
    let tokens: TokenSet;
    try {
      tokens = await flows.refresh(rt);
    } catch (e) {
      clearSessionCookies(c, req, res);
      throw e;
    }
    setSessionCookies(c, req, res, tokens);
    res.json({ ok: true, expiresIn: tokens.expiresIn });
  });

  app.post('/api/auth/logout', async (req, res) => {
    noStore(res);
    const cookies = req.cookies as Record<string, string> | undefined;
    const rt = cookies?.[REFRESH_COOKIE] ?? (typeof req.body?.refreshToken === 'string' ? req.body.refreshToken : '');
    const flows = c.auth.flows;
    if (flows && rt) await flows.logout(rt);
    clearSessionCookies(c, req, res);
    if (currentContext()?.principal) await audit(c, { action: 'user.logout', targetType: 'user', targetId: currentContext()?.userId ?? null });
    res.status(204).end();
  });

  app.post('/api/auth/forgot', limitMail, async (req, res) => {
    noStore(res);
    const body = parseBody(EmailBody, req.body);
    if (!body.email) throw new HttpError(400, 'VALIDATION_FAILED', '需要 email');
    await flowsOf(c).forgotPassword(body.email);
    res.status(202).json({ ok: true });
  });

  app.post('/api/auth/reset', limitMail, async (req, res) => {
    noStore(res);
    const body = parseBody(ResetBody, req.body);
    try {
      await flowsOf(c).confirmForgotPassword(body.email, body.code, body.newPassword);
    } catch (e) {
      await audit(c, { action: 'user.password_reset', result: 'denied', actor: { type: 'anonymous', email: body.email.toLowerCase() } });
      throw e;
    }
    clearSessionCookies(c, req, res);
    await audit(c, { action: 'user.password_reset', actor: { type: 'user', email: body.email.toLowerCase() } });
    res.json({ ok: true });
  });

  app.get('/api/auth/session', async (req, res) => {
    noStore(res);
    const ctx = currentContext();
    if (!ctx?.principal) {
      res.json({ authenticated: false, driver: driverOf(c.env, 'auth'), ...(typeof ctx?.locals.authError === 'string' ? { reason: ctx.locals.authError } : {}) });
      return;
    }
    const user = await directory.ensureUser(ctx.principal);
    const expiresAt = new Date(ctx.principal.expiresAt * 1000).toISOString();
    const body: Record<string, unknown> = { authenticated: true, user: toMe(user, ctx.principal), expiresAt };
    if (req.query.for === 'social') {
      // 跨域调用 social-api 时放进 Authorization 头的短期令牌（只存在前端内存中）：cognito = ID token，local = 本地 access token
      const cookies = req.cookies as Record<string, string> | undefined;
      const token = ctx.principal.provider === 'cognito'
        ? cookies?.[ID_TOKEN_COOKIE]
        : (cookies?.[ACCESS_COOKIE] ?? req.headers.authorization?.replace(/^Bearer\s+/i, ''));
      if (!token) throw new HttpError(401, 'NO_SESSION_TOKEN', '会话中没有可用的令牌');
      body.token = token;
    }
    res.json(body);
  });
}

// ------------------------------------------------------------------------------------------------
// /api/me/outbox（本人邮件预览，04#email；由 routes/me.ts 调用 registerSelfOutbox(app, c) 注册）
// ------------------------------------------------------------------------------------------------

interface OutboxBodyReader {
  readBody(row: Pick<OutboxEmailRow, 'eml_path'>): { from?: string; text: string | null; html: string | null } | null;
}

/** 读取正文：只有 outbox 驱动（或被 EMAIL_SANDBOX_POLICY=outbox 改写进 outbox 的邮件）才有 .eml */
export function outboxBodyOf(c: Container, row: OutboxEmailRow): { from?: string; text: string | null; html: string | null } | null {
  const reader = c.email as Partial<OutboxBodyReader>;
  if (typeof reader.readBody !== 'function' || !row.eml_path) return null;
  return reader.readBody(row);
}

export function outboxDetail(c: Container, row: OutboxEmailRow, emlUrl: string | null): Record<string, unknown> {
  const body = outboxBodyOf(c, row);
  const text = body?.text ?? null;
  return {
    ...toOutboxSummary(row),
    ...(body?.from ? { from: body.from } : {}),
    text,
    html: body?.html ?? null,
    hasBody: Boolean(body),
    links: [...new Set(text?.match(/https?:\/\/[^\s<>"')]+/g) ?? [])],
    emlUrl: body ? emlUrl : null,
  };
}

const SELF_PREVIEW_DISABLED_MESSAGE = '本站关闭了本人邮件预览（featureFlags[email.selfPreview]=false），请联系管理员在 /admin/outbox 查看';

export function registerSelfOutbox(app: Express, c: Container): void {
  const enabled = () => c.runtimeConfig().featureFlags['email.selfPreview'] !== false;

  app.get('/api/me/outbox', requireAuth, async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    if (!enabled()) throw new HttpError(403, 'SELF_PREVIEW_DISABLED', SELF_PREVIEW_DISABLED_MESSAGE);
    const me = currentUser();
    const limit = Math.min(Math.max(Number(req.query.limit ?? 20) || 20, 1), 100);
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
    const page = await listOutboxForRecipient(c.db, { userId: me.userId, email: me.email }, { limit, ...(cursor ? { cursor } : {}) });
    markPath('email', `${driverOf(c.env, 'email')}:preview`);
    res.json({
      items: page.items.map(toOutboxSummary), nextCursor: page.nextCursor, selfPreview: true, transport: driverOf(c.env, 'email'),
      notice: driverOf(c.env, 'email') === 'outbox' ? '本地实现，未真正发信：这些邮件只保存在本站服务器上，没有发到你的邮箱' : '邮件已由 Amazon SES 发出，请查收邮箱',
    });
  });

  app.get('/api/me/outbox/:id', requireAuth, async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    if (!enabled()) throw new HttpError(403, 'SELF_PREVIEW_DISABLED', SELF_PREVIEW_DISABLED_MESSAGE);
    const me = currentUser();
    const row = await findOutboxForRecipient(c.db, String(req.params.id), { userId: me.userId, email: me.email });
    if (!row) throw new HttpError(404, 'NOT_FOUND', '邮件不存在');
    markPath('email', `${driverOf(c.env, 'email')}:preview`);
    // 正文预览：前端用 iframe sandbox + srcdoc 显示 html，这里再加 CSP 防止脚本与外部资源
    res.set('Content-Security-Policy', "default-src 'none'; img-src data:; style-src 'unsafe-inline'; frame-ancestors 'self'");
    res.json(outboxDetail(c, row, null));
  });
}
