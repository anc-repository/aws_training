// backend/src/adapters/auth/local.ts —— AuthPort 的 `local` 驱动（本地实现，02#auth 第 1 节）
//
// - 密码：argon2id 哈希存 users.password_hash；失败计数与锁定（AUTH_LOCKOUT_THRESHOLD / AUTH_LOCKOUT_MINUTES）；统一错误防枚举。
// - 令牌：ES256 JWT（jose），私钥经 SecretsPort('jwt-signing-key')；JWKS 发布当前与上一版本 kid（D8）。
//   访问令牌带 tv 声明，校验时与 users.token_version 比对（按主键查询、进程内缓存 5 秒）——登出后旧令牌立即失效。
//   遇到未知 kid 时强制刷新一次密钥（最多每 30 秒一次），以支持轮换后的多实例。
// - 刷新令牌：随机串，库里只存 sha256；每次使用都轮换；同一族（family）的旧令牌被重放时整族作废。
// - 邮箱验证 / 找回密码：随机令牌（库里只存 sha256）经 EmailPort 发出（outbox 档写入本机 outbox）。
// - 注册事务内同时写 users 与默认相册（F2）；运行时配置 allowedEmailDomains 限制注册域名（F3）；access token 带 plan（F4）。
// - TOTP MFA：密钥经 CryptoPort 信封加密后存 users.mfa_secret_enc（L0 用本地主密钥）。
// - 未验证邮箱的用户也能登录，但得到的是受限会话（Principal.emailVerified=false；认证中间件只放行 /api/auth/*、/api/me、
//   /api/me/outbox*），这样“注册 → /me/outbox → 点验证链接”一个人就能走完（04#email）。
// 辅助代码在 adapters/auth/local/ 下（hash、keys、totp、password-policy、emails）。
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Knex } from 'knex';
import { decodeProtectedHeader, jwtVerify, SignJWT, errors as joseErrors } from 'jose';
import type { AdapterDeps } from '../types.js';
import { need } from '../types.js';
import type { AdapterMeta, ProbeResult } from '../../ports/common.js';
import type {
  AuthPort, AuthPublicConfig, EmbeddedAuthFlows, ExportedIdentity, LoginResult, Principal, TokenSet,
} from '../../ports/auth.js';
import { HttpError } from '../../errors.js';
import { boolIn, isUniqueViolation, toIso } from '../../db/dialect.js';
import { addTiming, currentContext, markPath } from '../../observability/request-context.js';
import { ensureDefaultAlbum } from '../../repositories/albums.js';
import {
  bumpTokenVersion, countUsers, deleteAuthTokens, deleteExpiredAuthTokens, findAuthTokenByHash, findUserByEmail, findUserById,
  insertAuthToken, insertUser, listUsersAfter, markAuthTokenUsed, normalizeEmail, recordLoginFailure, resetLoginFailures,
  updateUser, type AuthTokenType, type UserRow,
} from '../../repositories/users.js';
import { parseBlob, serializeBlob } from '../kms/local.js';
import { passwordResetEmail, verificationEmail } from './local/emails.js';
import { dummyVerify, hashPassword, MAX_PASSWORD_LENGTH, verifyPassword } from './local/hash.js';
import { JWT_ALG, loadSigningKey, previousKeyPath, type SigningKey } from './local/keys.js';
import { checkPassword, PASSWORD_POLICY } from './local/password-policy.js';
import { generateTotpSecret, otpauthUrl, verifyTotp } from './local/totp.js';

export const ACCESS_AUDIENCE = 'cloudalbum';
export const VERIFY_TTL_HOURS = 24;
export const RESET_TTL_MINUTES = 60;
export const MFA_CHALLENGE_TTL_SEC = 300;
const USER_CACHE_MS = 5000;
const KEY_RELOAD_MIN_INTERVAL_MS = 30_000;
const MFA_CRYPTO_CONTEXT = { app: 'cloudalbum', purpose: 'users.mfa_secret_enc' } as const;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** 访问令牌的声明（ES256，kid 在受保护头中） */
export interface LocalAccessClaims {
  sub: string; email: string; groups: string[]; plan: string; tv: number; ev: boolean; token_use: 'access';
}

interface UserState { tv: number; role: 'admin' | 'member'; plan: string; email: string; verified: boolean; disabled: boolean; at: number }

const invalidCredentials = () => new HttpError(401, 'INVALID_CREDENTIALS', '邮箱或密码不正确');
const invalidToken = (detail?: string) => new HttpError(401, 'INVALID_TOKEN', detail ?? '访问令牌无效或已过期');

export class LocalAuth implements AuthPort {
  readonly meta: AdapterMeta = { module: 'auth', driver: 'local', awsService: null, authoritative: true };
  /** local 驱动提供 EmbeddedAuthFlows（注册、登录、找回密码等由 EC2 处理） */
  readonly flows: EmbeddedAuthFlows;

  private current: SigningKey | undefined;
  private previous: SigningKey | undefined;
  private keyError: string | undefined;
  private prevKeyError: string | undefined;
  private lastKeyLoadAt = 0;
  private readonly userCache = new Map<string, UserState>();
  private loginFailures = { total: 0, windowStart: Date.now() };

  constructor(protected readonly deps: AdapterDeps) {
    this.flows = this.createFlows();
  }

  // ----------------------------------------------------------------------------------------------
  // 基础设施
  // ----------------------------------------------------------------------------------------------

  private get db(): Knex {
    return need(this.deps, 'db', 'LocalAuth');
  }

  private get cfg() {
    return this.deps.cfg.auth;
  }

  get issuer(): string {
    return new URL(this.deps.cfg.core.APP_BASE_URL).origin;
  }

  async init(): Promise<void> {
    await this.loadKeys();
  }

  /** 读取当前与上一版本私钥；当前私钥缺失时抛出（init 失败 → 探针 error，不中断启动） */
  async loadKeys(): Promise<void> {
    this.lastKeyLoadAt = Date.now();
    const secrets = need(this.deps, 'secrets', 'LocalAuth');
    try {
      this.current = await loadSigningKey(await secrets.get('jwt-signing-key'));
      this.keyError = undefined;
    } catch (e) {
      this.keyError = (e as Error).message;
      throw new HttpError(503, 'AUTH_KEYS_UNAVAILABLE', `ES256 签名私钥不可用：${this.keyError}`);
    }
    const currentFile = this.deps.env.JWT_SIGNING_KEY_FILE || this.cfg.JWT_SIGNING_KEY_FILE;
    this.prevKeyError = undefined;
    this.previous = undefined;
    let prevPem: string | undefined;
    try {
      prevPem = readFileSync(previousKeyPath(currentFile), 'utf8');
    } catch {
      prevPem = undefined;                    // 没有轮换过：只有一个 kid 是正常状态
    }
    if (prevPem) {
      try {
        const prev = await loadSigningKey(prevPem);
        if (prev.kid !== this.current.kid) this.previous = prev;
      } catch (e) {
        this.prevKeyError = (e as Error).message;
      }
    }
  }

  private keyFor(kid: string | undefined): SigningKey | undefined {
    if (!kid) return undefined;
    if (this.current?.kid === kid) return this.current;
    if (this.previous?.kid === kid) return this.previous;
    return undefined;
  }

  private requireCurrentKey(): SigningKey {
    if (!this.current) throw new HttpError(503, 'AUTH_KEYS_UNAVAILABLE', `ES256 签名私钥不可用：${this.keyError ?? '尚未加载'}`);
    return this.current;
  }

  /** 流程方法不经 instrument 代理（flows 是普通对象），这里手动记入 Server-Timing 与路径头 */
  private async timed<T>(fn: () => Promise<T>): Promise<T> {
    const t0 = performance.now();
    currentContext()?.path.markIfAbsent('auth', 'local');
    try {
      return await fn();
    } finally {
      addTiming('auth', performance.now() - t0);
    }
  }

  private invalidate(userId: string): void {
    this.userCache.delete(userId);
  }

  private async userState(userId: string): Promise<UserState | undefined> {
    const hit = this.userCache.get(userId);
    if (hit && Date.now() - hit.at < USER_CACHE_MS) return hit;
    const u = await findUserById(this.db, userId);
    if (!u) {
      this.userCache.delete(userId);
      return undefined;
    }
    const s: UserState = {
      tv: Number(u.token_version), role: u.role, plan: u.plan, email: u.email, verified: boolIn(u.email_verified),
      disabled: boolIn(u.disabled), at: Date.now(),
    };
    this.userCache.set(userId, s);
    return s;
  }

  private runtimeConfig() {
    try {
      return this.deps.runtime?.current();
    } catch {
      return undefined;
    }
  }

  // ----------------------------------------------------------------------------------------------
  // 令牌
  // ----------------------------------------------------------------------------------------------

  private async signAccessToken(u: UserRow): Promise<{ token: string; expiresIn: number }> {
    const key = this.requireCurrentKey();
    const ttl = this.cfg.AUTH_ACCESS_TTL_SEC;
    const claims: Omit<LocalAccessClaims, 'sub'> = {
      email: u.email, groups: [u.role], plan: u.plan, tv: Number(u.token_version), ev: boolIn(u.email_verified), token_use: 'access',
    };
    const token = await new SignJWT({ ...claims })
      .setProtectedHeader({ alg: JWT_ALG, kid: key.kid, typ: 'JWT' })
      .setSubject(u.id)
      .setIssuer(this.issuer)
      .setAudience(ACCESS_AUDIENCE)
      .setIssuedAt()
      .setJti(randomUUID())
      .setExpirationTime(`${ttl}s`)
      .sign(key.privateKey);
    return { token, expiresIn: ttl };
  }

  /** 签发访问令牌 + 新的刷新令牌（familyId 为空时开启新的一族） */
  private async issueTokens(u: UserRow, familyId: string = randomUUID()): Promise<TokenSet> {
    const { token, expiresIn } = await this.signAccessToken(u);
    const refreshToken = randomToken(32);
    const expiresAt = new Date(Date.now() + this.cfg.AUTH_REFRESH_TTL_DAYS * 86_400_000).toISOString();
    await insertAuthToken(this.db, { userId: u.id, type: 'refresh', tokenHash: sha256Hex(refreshToken), familyId, expiresAt });
    if (Math.random() < 0.02) void deleteExpiredAuthTokens(this.db).catch(() => undefined);
    return { accessToken: token, refreshToken, expiresIn };
  }

  async verifyAccessToken(token: string): Promise<Principal> {
    markPath('auth', 'local:verify');
    let kid: string | undefined;
    try {
      kid = decodeProtectedHeader(token).kid;
    } catch {
      throw invalidToken();
    }
    let key = this.keyFor(kid);
    if (!key && Date.now() - this.lastKeyLoadAt > KEY_RELOAD_MIN_INTERVAL_MS) {
      await this.loadKeys().catch(() => undefined);           // 轮换后的多实例：强制刷新一次（有频率限制）
      key = this.keyFor(kid);
    }
    if (!key) throw invalidToken('未知的签名密钥（kid）');
    let payload: Record<string, unknown>;
    try {
      ({ payload } = await jwtVerify(token, key.publicKey, {
        issuer: this.issuer, audience: ACCESS_AUDIENCE, algorithms: [JWT_ALG], clockTolerance: 5,
      }));
    } catch (e) {
      throw invalidToken(e instanceof joseErrors.JWTExpired ? '访问令牌已过期' : undefined);
    }
    if (payload.token_use !== 'access' || typeof payload.sub !== 'string') throw invalidToken();
    const state = await this.userState(payload.sub);
    if (!state) throw invalidToken('用户不存在');
    if (state.disabled) throw invalidToken('账号已被禁用');
    if (Number(payload.tv) !== state.tv) throw new HttpError(401, 'TOKEN_REVOKED', '令牌已失效（已登出或密码已重置）');
    return {
      provider: 'local',
      subject: payload.sub,
      email: state.email,
      emailVerified: state.verified,
      groups: [state.role],
      plan: state.plan,
      expiresAt: Number(payload.exp ?? 0),
    };
  }

  jwks(): { keys: Array<Record<string, string>> } | null {
    const key = this.requireCurrentKey();
    return { keys: [key.publicJwk, ...(this.previous ? [this.previous.publicJwk] : [])] };
  }

  publicConfig(): AuthPublicConfig {
    return { driver: 'local', passwordPolicy: { ...PASSWORD_POLICY }, mfa: this.cfg.AUTH_MFA === 'off' ? 'off' : 'optional' };
  }

  // ----------------------------------------------------------------------------------------------
  // 邮件
  // ----------------------------------------------------------------------------------------------

  private async createOneTimeToken(userId: string, type: AuthTokenType, ttlMs: number): Promise<string> {
    await deleteAuthTokens(this.db, { userId, type });       // 同类旧令牌作废（只有最新一封邮件有效）
    const code = randomToken(18);
    await insertAuthToken(this.db, { userId, type, tokenHash: sha256Hex(code), expiresAt: new Date(Date.now() + ttlMs).toISOString() });
    return code;
  }

  private async sendVerification(u: UserRow): Promise<void> {
    const code = await this.createOneTimeToken(u.id, 'verify_email', VERIFY_TTL_HOURS * 3_600_000);
    const email = need(this.deps, 'email', 'LocalAuth');
    await email.send(verificationEmail({
      to: u.email, displayName: u.display_name, code, baseUrl: this.deps.cfg.core.APP_BASE_URL, ttlHours: VERIFY_TTL_HOURS,
    }));
  }

  /** 校验一次性令牌（验证码 / 重置码）：必须属于该邮箱的用户、未使用、未过期；成功后原子标记为已使用 */
  private async consumeOneTimeToken(email: string, code: string, type: AuthTokenType, errCode: string): Promise<UserRow> {
    const bad = () => new HttpError(400, errCode, '验证码无效或已过期');
    if (!code || code.length > 200) throw bad();
    const u = await findUserByEmail(this.db, email);
    const tok = await findAuthTokenByHash(this.db, sha256Hex(code.trim()), type);
    if (!u || !tok || tok.user_id !== u.id || tok.used_at || Date.parse(tok.expires_at) <= Date.now()) throw bad();
    if (!(await markAuthTokenUsed(this.db, tok.id))) throw bad();
    return u;
  }

  // ----------------------------------------------------------------------------------------------
  // MFA
  // ----------------------------------------------------------------------------------------------

  private async decryptMfaSecret(u: UserRow): Promise<string> {
    if (!u.mfa_secret_enc) throw new HttpError(400, 'MFA_NOT_ENROLLED', '尚未设置 MFA');
    const crypto = need(this.deps, 'crypto', 'LocalAuth');
    const plain = await crypto.decrypt(parseBlob(u.mfa_secret_enc), MFA_CRYPTO_CONTEXT, { rowId: u.id });
    return plain.toString('utf8');
  }

  // ----------------------------------------------------------------------------------------------
  // EmbeddedAuthFlows
  // ----------------------------------------------------------------------------------------------

  private createFlows(): EmbeddedAuthFlows {
    const self = this as LocalAuth;   // 流程对象的方法需要引用适配器实例
    return {
      register: (input) => self.timed(() => self.register(input)),
      confirmRegistration: (email, code) => self.timed(async () => {
        const u = await self.consumeOneTimeToken(normalizeEmail(email), code, 'verify_email', 'INVALID_CODE');
        await updateUser(self.db, u.id, { email_verified: true });
        await deleteAuthTokens(self.db, { userId: u.id, type: 'verify_email' });
        self.invalidate(u.id);
      }),
      resendCode: (email) => self.timed(async () => {
        const u = await findUserByEmail(self.db, email);
        if (!u || boolIn(u.email_verified) || boolIn(u.disabled) || u.auth_provider !== 'local') return;   // 静默：防枚举
        await self.sendVerification(u);
      }),
      login: (email, password) => self.timed(() => self.login(email, password)),
      completeMfa: (challengeId, totp) => self.timed(() => self.completeMfa(challengeId, totp)),
      refresh: (refreshToken) => self.timed(() => self.refresh(refreshToken)),
      logout: (refreshToken) => self.timed(() => self.logout(refreshToken)),
      forgotPassword: (email) => self.timed(async () => {
        const u = await findUserByEmail(self.db, email);
        // 静默：防枚举。cognito 回滚到 local 后，只在 Cognito 注册过的用户没有本地密码，也走这里设置（02#auth 第 6 节）
        if (!u || boolIn(u.disabled)) return;
        const code = await self.createOneTimeToken(u.id, 'reset_password', RESET_TTL_MINUTES * 60_000);
        await need(self.deps, 'email', 'LocalAuth').send(passwordResetEmail({
          to: u.email, displayName: u.display_name, code, baseUrl: self.deps.cfg.core.APP_BASE_URL, ttlMinutes: RESET_TTL_MINUTES,
        }));
      }),
      confirmForgotPassword: (email, code, newPassword) => self.timed(async () => {
        const violations = checkPassword(newPassword, { email });
        if (violations.length) throw new HttpError(400, 'WEAK_PASSWORD', `密码不符合策略：${violations.join('；')}`, { violations });
        const u = await self.consumeOneTimeToken(normalizeEmail(email), code, 'reset_password', 'INVALID_CODE');
        await updateUser(self.db, u.id, {
          password_hash: await hashPassword(newPassword), email_verified: true, failed_logins: 0, locked_until: null, auth_provider: 'local',
          auth_subject: u.id,
        });
        await bumpTokenVersion(self.db, u.id);
        await deleteAuthTokens(self.db, { userId: u.id, type: 'refresh' });
        await deleteAuthTokens(self.db, { userId: u.id, type: 'reset_password' });
        self.invalidate(u.id);
      }),
      setupTotp: (subject) => self.timed(async () => {
        if (self.cfg.AUTH_MFA === 'off') throw new HttpError(400, 'MFA_DISABLED', 'AUTH_MFA=off：本站未开启 MFA');
        const u = await findUserById(self.db, subject);
        if (!u) throw new HttpError(404, 'USER_NOT_FOUND', '用户不存在');
        if (boolIn(u.mfa_enabled)) throw new HttpError(409, 'MFA_ALREADY_ENABLED', '已经开启了 MFA');
        const secret = generateTotpSecret();
        const crypto = need(self.deps, 'crypto', 'LocalAuth');
        const blob = await crypto.encrypt(Buffer.from(secret, 'utf8'), MFA_CRYPTO_CONTEXT, { rowId: u.id });
        await updateUser(self.db, u.id, { mfa_secret_enc: serializeBlob(blob), mfa_enabled: false });
        return { otpauthUrl: otpauthUrl({ issuer: 'CloudAlbum', account: u.email, secret }) };
      }),
      verifyTotp: (subject, code) => self.timed(async () => {
        const u = await findUserById(self.db, subject);
        if (!u) throw new HttpError(404, 'USER_NOT_FOUND', '用户不存在');
        const secret = await self.decryptMfaSecret(u);
        if (!verifyTotp(secret, code)) throw new HttpError(400, 'INVALID_MFA_CODE', '动态验证码不正确');
        await updateUser(self.db, u.id, { mfa_enabled: true });
        self.invalidate(u.id);
      }),
    };
  }

  private async register(input: { email: string; password: string; displayName: string }): Promise<{ subject: string; needsConfirmation: boolean }> {
    const email = normalizeEmail(input.email ?? '');
    if (!EMAIL_RE.test(email) || email.length > 320) throw new HttpError(400, 'INVALID_EMAIL', '邮箱格式不正确');
    const domain = email.split('@')[1]!;
    const allowed = this.runtimeConfig()?.allowedEmailDomains ?? [];
    if (allowed.length && !allowed.some((d) => domain === d || domain.endsWith(`.${d}`))) {
      throw new HttpError(403, 'EMAIL_DOMAIN_NOT_ALLOWED', `只允许以下域名的邮箱注册：${allowed.join(', ')}`);
    }
    const violations = checkPassword(input.password ?? '', { email });
    if (violations.length) throw new HttpError(400, 'WEAK_PASSWORD', `密码不符合策略：${violations.join('；')}`, { violations });
    const displayName = (input.displayName ?? '').trim().slice(0, 120) || email.split('@')[0]!;
    if (await findUserByEmail(this.db, email)) throw new HttpError(409, 'EMAIL_TAKEN', '该邮箱已注册');
    const passwordHash = await hashPassword(input.password);
    let user: UserRow;
    try {
      user = await this.db.transaction(async (trx) => {
        const u = await insertUser(trx, { email, displayName, passwordHash, emailVerified: false, authProvider: 'local' });
        await ensureDefaultAlbum(trx, u.id);
        return u;
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw new HttpError(409, 'EMAIL_TAKEN', '该邮箱已注册');
      throw e;
    }
    try {
      await this.sendVerification(user);
    } catch (e) {
      this.deps.logger?.warn('verification email failed (user can resend)', { userId: user.id, error: (e as Error).message });
    }
    return { subject: user.id, needsConfirmation: true };
  }

  private noteLoginFailure(): void {
    const now = Date.now();
    if (now - this.loginFailures.windowStart > 300_000) this.loginFailures = { total: 0, windowStart: now };
    this.loginFailures.total += 1;
  }

  private async login(emailRaw: string, password: string): Promise<LoginResult> {
    const email = normalizeEmail(emailRaw ?? '');
    const u = email ? await findUserByEmail(this.db, email) : undefined;
    if (!u || !u.password_hash || typeof password !== 'string' || password.length > MAX_PASSWORD_LENGTH) {
      await dummyVerify(typeof password === 'string' ? password : '');
      this.noteLoginFailure();
      throw invalidCredentials();
    }
    const lockedUntil = toIso(u.locked_until);
    if (lockedUntil && Date.parse(lockedUntil) > Date.now()) {
      this.noteLoginFailure();
      throw new HttpError(423, 'ACCOUNT_LOCKED', `连续登录失败次数过多，账号已临时锁定，请在 ${lockedUntil} 之后再试`, { lockedUntil },
        { 'Retry-After': String(Math.max(1, Math.ceil((Date.parse(lockedUntil) - Date.now()) / 1000))) });
    }
    if (!(await verifyPassword(u.password_hash, password))) {
      this.noteLoginFailure();
      const r = await recordLoginFailure(this.db, u.id, this.cfg.AUTH_LOCKOUT_THRESHOLD, this.cfg.AUTH_LOCKOUT_MINUTES);
      if (r.lockedUntil && Date.parse(r.lockedUntil) > Date.now()) {
        throw new HttpError(423, 'ACCOUNT_LOCKED', `连续登录失败次数过多，账号已临时锁定 ${this.cfg.AUTH_LOCKOUT_MINUTES} 分钟`,
          { lockedUntil: r.lockedUntil }, { 'Retry-After': String(this.cfg.AUTH_LOCKOUT_MINUTES * 60) });
      }
      throw invalidCredentials();
    }
    if (Number(u.failed_logins ?? 0) > 0 || u.locked_until) await resetLoginFailures(this.db, u.id);
    if (boolIn(u.disabled)) throw new HttpError(403, 'ACCOUNT_DISABLED', '账号已被管理员禁用');
    if (boolIn(u.mfa_enabled) && this.cfg.AUTH_MFA !== 'off') {
      const challengeId = randomToken(24);
      await insertAuthToken(this.db, {
        userId: u.id, type: 'mfa_challenge', tokenHash: sha256Hex(challengeId),
        expiresAt: new Date(Date.now() + MFA_CHALLENGE_TTL_SEC * 1000).toISOString(),
      });
      return { kind: 'mfa_required', challengeId };
    }
    return { kind: 'tokens', tokens: await this.issueTokens(u) };
  }

  private async completeMfa(challengeId: string, code: string): Promise<TokenSet> {
    const bad = () => new HttpError(401, 'INVALID_MFA_CHALLENGE', 'MFA 挑战无效或已过期，请重新登录');
    const tok = challengeId ? await findAuthTokenByHash(this.db, sha256Hex(challengeId), 'mfa_challenge') : undefined;
    if (!tok || tok.used_at || Date.parse(tok.expires_at) <= Date.now()) throw bad();
    const u = await findUserById(this.db, tok.user_id);
    if (!u || boolIn(u.disabled)) throw bad();
    const secret = await this.decryptMfaSecret(u);
    if (!verifyTotp(secret, code ?? '')) {
      this.noteLoginFailure();
      const r = await recordLoginFailure(this.db, u.id, this.cfg.AUTH_LOCKOUT_THRESHOLD, this.cfg.AUTH_LOCKOUT_MINUTES);
      if (r.lockedUntil) {
        await deleteAuthTokens(this.db, { userId: u.id, type: 'mfa_challenge' });
        throw new HttpError(423, 'ACCOUNT_LOCKED', `连续验证失败次数过多，账号已临时锁定 ${this.cfg.AUTH_LOCKOUT_MINUTES} 分钟`);
      }
      throw new HttpError(401, 'INVALID_MFA_CODE', '动态验证码不正确');
    }
    if (!(await markAuthTokenUsed(this.db, tok.id))) throw bad();
    await resetLoginFailures(this.db, u.id);
    return this.issueTokens(u);
  }

  private async refresh(refreshToken: string): Promise<TokenSet> {
    const bad = (code = 'INVALID_REFRESH_TOKEN', msg = '刷新令牌无效或已过期，请重新登录') => new HttpError(401, code, msg);
    if (!refreshToken || refreshToken.length > 200) throw bad();
    const tok = await findAuthTokenByHash(this.db, sha256Hex(refreshToken), 'refresh');
    if (!tok) throw bad();
    const revokeFamily = async () => {
      if (tok.family_id) await deleteAuthTokens(this.db, { familyId: tok.family_id });
    };
    if (tok.used_at) {
      await revokeFamily();                                  // 旧令牌被重放：整族作废（令牌可能被盗）
      throw bad('REFRESH_TOKEN_REUSED', '刷新令牌已被使用过，出于安全考虑本会话已全部失效，请重新登录');
    }
    if (Date.parse(tok.expires_at) <= Date.now()) throw bad();
    const u = await findUserById(this.db, tok.user_id);
    if (!u || boolIn(u.disabled)) {
      await revokeFamily();
      throw bad();
    }
    if (!(await markAuthTokenUsed(this.db, tok.id))) {
      await revokeFamily();
      throw bad('REFRESH_TOKEN_REUSED', '刷新令牌已被使用过，出于安全考虑本会话已全部失效，请重新登录');
    }
    return this.issueTokens(u, tok.family_id ?? randomUUID());
  }

  private async logout(refreshToken: string): Promise<void> {
    if (!refreshToken) return;
    const tok = await findAuthTokenByHash(this.db, sha256Hex(refreshToken), 'refresh');
    if (!tok) return;
    if (tok.family_id) await deleteAuthTokens(this.db, { familyId: tok.family_id });
    else await deleteAuthTokens(this.db, { userId: tok.user_id, type: 'refresh' });
    await bumpTokenVersion(this.db, tok.user_id);          // 旧 access token 立即失效（tv 检查）
    this.invalidate(tok.user_id);
  }

  // ----------------------------------------------------------------------------------------------
  // 管理
  // ----------------------------------------------------------------------------------------------

  async adminSetGroups(subject: string, groups: string[]): Promise<void> {
    const u = await findUserById(this.db, subject);
    if (!u) throw new HttpError(404, 'USER_NOT_FOUND', '用户不存在');
    await updateUser(this.db, subject, { role: groups.includes('admin') ? 'admin' : 'member' });
    this.invalidate(subject);
  }

  async adminDisableUser(subject: string): Promise<void> {
    const u = await findUserById(this.db, subject);
    if (!u) throw new HttpError(404, 'USER_NOT_FOUND', '用户不存在');
    await updateUser(this.db, subject, { disabled: true });
    await bumpTokenVersion(this.db, subject);
    await deleteAuthTokens(this.db, { userId: subject, type: 'refresh' });
    this.invalidate(subject);
  }

  // ----------------------------------------------------------------------------------------------
  // Migratable<ExportedIdentity>（scripts/migrate/auth；密码哈希不跨驱动迁移）
  // ----------------------------------------------------------------------------------------------

  async count(): Promise<number> {
    return countUsers(this.db, { provider: 'local' });
  }

  async exportBatch(cursor?: string, limit = 100): Promise<{ items: ExportedIdentity[]; next?: string }> {
    const rows = await listUsersAfter(this.db, { ...(cursor ? { afterId: cursor } : {}), limit, provider: 'local' });
    const items = rows.map((u) => ({
      subject: u.id, email: u.email, emailVerified: boolIn(u.email_verified), groups: [u.role], plan: u.plan, mfaEnabled: boolIn(u.mfa_enabled),
    }));
    const last = rows[rows.length - 1];
    return rows.length === limit && last ? { items, next: last.id } : { items };
  }

  /** 回滚（cognito → local）时导入：已有同邮箱的用户改回 local（无密码，需走找回密码）；没有则新建用户 + 默认相册 */
  async importBatch(items: ExportedIdentity[]): Promise<{ written: number; skipped: number }> {
    let written = 0;
    let skipped = 0;
    for (const it of items) {
      const existing = await findUserByEmail(this.db, it.email);
      if (existing) {
        if (existing.auth_provider === 'local' && existing.auth_subject === existing.id) {
          skipped += 1;
          continue;
        }
        await updateUser(this.db, existing.id, { auth_provider: 'local', auth_subject: existing.id });
        this.invalidate(existing.id);
        written += 1;
        continue;
      }
      await this.db.transaction(async (trx) => {
        const u = await insertUser(trx, {
          email: it.email, displayName: it.email.split('@')[0] ?? 'user', passwordHash: null, emailVerified: it.emailVerified,
          role: it.groups.includes('admin') ? 'admin' : 'member', plan: it.plan, authProvider: 'local',
        });
        await ensureDefaultAlbum(trx, u.id);
      });
      written += 1;
    }
    return { written, skipped };
  }

  // ----------------------------------------------------------------------------------------------
  // 探针
  // ----------------------------------------------------------------------------------------------

  async probe(opts?: { deep?: boolean }): Promise<ProbeResult> {
    if (!this.current) {
      await this.loadKeys().catch(() => undefined);
      if (!this.current) return { status: 'error', detail: `ES256 签名私钥不可用：${this.keyError ?? '未配置'}` };
    }
    try {
      await this.db('users').select('id').limit(1);
    } catch (e) {
      return { status: 'error', detail: `users 表不可读：${(e as Error).message}` };
    }
    if (opts?.deep) {
      const t = await new SignJWT({ token_use: 'probe' }).setProtectedHeader({ alg: JWT_ALG, kid: this.current.kid })
        .setIssuer(this.issuer).setAudience(ACCESS_AUDIENCE).setExpirationTime('30s').sign(this.current.privateKey);
      await jwtVerify(t, this.current.publicKey, { issuer: this.issuer, audience: ACCESS_AUDIENCE });
    }
    const kids = [this.current.kid, ...(this.previous ? [this.previous.kid] : [])];
    const data = { kids, issuer: this.issuer, accessTtlSec: this.cfg.AUTH_ACCESS_TTL_SEC, loginFailures5m: this.loginFailures.total,
      ...(this.prevKeyError ? { previousKeyError: this.prevKeyError } : {}) };
    if (this.prevKeyError) {
      return { status: 'degraded', detail: `上一版本私钥无法解析（轮换窗口内旧令牌将无法验签）：${this.prevKeyError}`, data };
    }
    return {
      status: 'ok',
      detail: `本地账号（argon2id）· ES256 · JWKS ${kids.length} 个 kid（${kids.map((k) => k.slice(0, 8)).join('、')}）· users 表可读`,
      data,
    };
  }
}
