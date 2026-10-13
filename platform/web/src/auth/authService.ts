/**
 * 认证服务（08 P01、§2.4 表 1 第 1、2 条；01 §5.3）。实现 ApiClient 的 TokenSource。
 *
 * - 生产：Cognito 托管登录（授权码 + PKCE）。访问令牌只在内存；刷新令牌在 sessionStorage（关闭标签页即失效）；
 *   `code_verifier`、`state`、`next` 存 sessionStorage，回调后立即删除；`next` 只允许站内相对路径（防开放重定向）。
 * - 本地开发（config.json `auth: "dev"` 且页面在本机地址）：dev-server 认可的开发令牌 `dev.<group>.<sub>[.<authTime>]`，
 *   “刷新令牌”是同一个开发身份；“需要重新登录”时重新登录即得到新的 auth_time。
 * - 退出：清空内存令牌与 sessionStorage 中的刷新令牌，撤销刷新令牌，并通过 BroadcastChannel('atl-auth') 通知其他标签页一起退出。
 */
import type { CognitoGroup } from '@atl/shared';
import { openChannel, type Channel } from '../lib/broadcast';
import { ssGet, ssSet, STORAGE_KEYS } from '../lib/storage';
import type { TokenSource } from '../api/client';
import { authModeOf, type AuthMode, type PlatformConfigJson } from './config';
import { authorizeUrl, exchangeCode, logoutUrl, pkceChallenge, randomUrlSafe, refreshTokens, revokeRefreshToken } from './cognito';
import { principalFromToken, type Principal } from './jwt';

export type AuthStatus = 'initializing' | 'anonymous' | 'authenticated';

export interface AuthSnapshot {
  status: AuthStatus;
  mode: AuthMode | null;
  principal: Principal | null;
  /** 其他标签页退出（P01 `reason=signed-out-elsewhere`）。 */
  signedOutElsewhere: boolean;
  /** 使用中静默刷新失败：保留当前页面与身份，弹出“登录已过期”（P13 #5），不再发出带令牌的请求。 */
  expired: boolean;
  /** 本标签页曾经登录过（启动时有刷新令牌，或登录过）：未登录时的重定向带 reason=expired。 */
  hadSession: boolean;
}

interface LoginRequest {
  state: string;
  verifier: string;
  next: string;
  createdAt: number;
}

interface DevIdentity {
  dev: true;
  group: CognitoGroup;
  sub: string;
  authTime?: number;
}

/** 只允许站内相对路径（`/…`，不允许 `//host`、`/\host`）。 */
export function safeNext(next: string | null | undefined, fallback = '/'): string {
  if (!next || typeof next !== 'string') return fallback;
  if (!next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return fallback;
  if (/^\/auth\//.test(next) || next.startsWith('/login')) return fallback;
  return next;
}

export function devToken(group: CognitoGroup, sub: string, authTime?: number): string {
  return `dev.${group}.${sub}${authTime === undefined ? '' : `.${authTime}`}`;
}

export interface AuthServiceOptions {
  config: PlatformConfigJson;
  fetchImpl?: typeof fetch;
  location?: Pick<Location, 'origin' | 'hostname' | 'assign'>;
  channel?: Channel | null;
  nowMs?: () => number;
}

/** 访问令牌在到期前 60 秒内视为需要刷新。 */
const EXPIRY_MARGIN_MS = 60_000;
/** 登录请求有效期（state 过期视为旧登录页）。 */
const LOGIN_REQUEST_TTL_MS = 30 * 60_000;

export class AuthService implements TokenSource {
  readonly config: PlatformConfigJson;
  readonly mode: AuthMode | null;
  private readonly fetchImpl: typeof fetch;
  private readonly loc: Pick<Location, 'origin' | 'hostname' | 'assign'>;
  private readonly channel: Channel | null;
  private readonly nowMs: () => number;
  private accessToken: string | null = null;
  private refreshing: Promise<boolean> | null = null;
  private snap: AuthSnapshot;
  private readonly listeners = new Set<() => void>();

  constructor(opts: AuthServiceOptions) {
    this.config = opts.config;
    this.fetchImpl = opts.fetchImpl ?? ((...a) => globalThis.fetch(...a));
    this.loc = opts.location ?? globalThis.location;
    this.mode = authModeOf(opts.config, this.loc.hostname);
    this.channel = opts.channel === undefined ? openChannel('atl-auth') : opts.channel;
    this.nowMs = opts.nowMs ?? (() => Date.now());
    this.snap = { status: 'initializing', mode: this.mode, principal: null, signedOutElsewhere: false, expired: false, hadSession: false };
    if (this.channel) {
      this.channel.onmessage = (ev) => {
        if ((ev.data as { t?: string } | null)?.t === 'signout') this.clear(true);
      };
    }
  }

  getSnapshot = (): AuthSnapshot => this.snap;

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  /** 启动：有刷新令牌时静默刷新（§2.4 表 1 第 2 条）。 */
  async init(): Promise<AuthSnapshot> {
    if (this.snap.status !== 'initializing') return this.snap;
    const had = this.hasRefreshToken();
    if (had) this.set({ hadSession: true });
    const ok = had ? await this.refresh() : false;
    if (!ok) this.set({ status: 'anonymous', principal: null });
    return this.snap;
  }

  hasRefreshToken(): boolean {
    return ssGet<unknown>(STORAGE_KEYS.refreshToken, null) !== null;
  }

  async getAccessToken(): Promise<string | null> {
    if (this.snap.expired) return null;
    if (this.accessToken) {
      const exp = this.snap.principal?.expiresAt;
      if (!exp || exp - this.nowMs() > EXPIRY_MARGIN_MS) return this.accessToken;
    }
    if (!this.hasRefreshToken()) return this.accessToken;
    return (await this.refresh()) ? this.accessToken : null;
  }

  /** 用刷新令牌换新的访问令牌；失败时清空登录状态（P13 #5 由 ApiClient 的 onUnauthenticated 处理）。 */
  refresh(): Promise<boolean> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.doRefresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async doRefresh(): Promise<boolean> {
    const stored = ssGet<string | DevIdentity | null>(STORAGE_KEYS.refreshToken, null);
    if (!stored) return false;
    try {
      if (typeof stored === 'object' && stored.dev) {
        if (this.mode !== 'dev') throw new Error('dev identity outside dev mode');
        return this.accept(devToken(stored.group, stored.sub, stored.authTime));
      }
      if (this.mode !== 'cognito' || typeof stored !== 'string') throw new Error('no refresh path');
      const t = await refreshTokens(this.config, stored, this.fetchImpl);
      if (t.refreshToken) ssSet(STORAGE_KEYS.refreshToken, t.refreshToken);
      return this.accept(t.accessToken);
    } catch {
      this.fail();
      return false;
    }
  }

  /** 刷新失败：启动阶段 → 未登录；使用中 → 标记过期（页面保留，弹出“登录已过期”）。 */
  private fail(): void {
    this.accessToken = null;
    ssSet(STORAGE_KEYS.refreshToken, undefined);
    if (this.snap.status === 'authenticated') this.set({ expired: true });
    else this.set({ status: 'anonymous', principal: null });
  }

  private accept(token: string): boolean {
    const principal = principalFromToken(token, Math.floor(this.nowMs() / 1000));
    if (!principal) {
      this.clear(false);
      return false;
    }
    this.accessToken = token;
    this.set({ status: 'authenticated', principal, signedOutElsewhere: false, expired: false, hadSession: true });
    return true;
  }

  /** 跳转托管登录（P01“使用平台账号登录”）。开发模式由登录页的开发表单调用 devLogin。 */
  async beginLogin(next: string): Promise<void> {
    if (this.mode !== 'cognito') throw new Error('Cognito hosted login is not configured');
    const verifier = randomUrlSafe(48);
    const state = randomUrlSafe(24);
    const req: LoginRequest = { state, verifier, next: safeNext(next), createdAt: this.nowMs() };
    ssSet(STORAGE_KEYS.loginRequest, req);
    const challenge = await pkceChallenge(verifier);
    this.loc.assign(authorizeUrl(this.config, { state, challenge }, this.loc));
  }

  /**
   * 授权码回调（/auth/callback）：校验 state、换取令牌，返回登录后的去向。
   * 结果：`ok`（next）、`stale`（state 不匹配或缺失）、`error`（Cognito 返回错误）、`token-failed`（网络或令牌端点错误）。
   */
  async completeLogin(params: URLSearchParams): Promise<{ result: 'ok'; next: string } | { result: 'stale' | 'token-failed' } | { result: 'error'; error: string }> {
    const req = ssGet<LoginRequest | null>(STORAGE_KEYS.loginRequest, null);
    ssSet(STORAGE_KEYS.loginRequest, undefined);
    const err = params.get('error');
    if (err) return { result: 'error', error: params.get('error_description') ?? err };
    const code = params.get('code');
    const state = params.get('state');
    if (!req || !code || !state || state !== req.state || this.nowMs() - req.createdAt > LOGIN_REQUEST_TTL_MS) return { result: 'stale' };
    try {
      const t = await exchangeCode(this.config, code, req.verifier, this.fetchImpl, this.loc);
      if (t.refreshToken) ssSet(STORAGE_KEYS.refreshToken, t.refreshToken);
      if (!this.accept(t.accessToken)) return { result: 'token-failed' };
      return { result: 'ok', next: safeNext(req.next) };
    } catch {
      return { result: 'token-failed' };
    }
  }

  /** 开发模式登录：`staleAuth` 模拟 61 分钟前登录（触发 REAUTH_REQUIRED）。 */
  devLogin(group: CognitoGroup, sub: string, opts: { staleAuth?: boolean } = {}): boolean {
    if (this.mode !== 'dev') throw new Error('dev login is only available in dev mode on a local host');
    const authTime = opts.staleAuth ? Math.floor(this.nowMs() / 1000) - 61 * 60 : undefined;
    const ident: DevIdentity = { dev: true, group, sub, ...(authTime ? { authTime } : {}) };
    ssSet(STORAGE_KEYS.refreshToken, ident);
    return this.accept(devToken(group, sub, authTime));
  }

  /** 退出（AccountMenu“退出”）：清空令牌、通知其他标签页，跳转 Cognito 登出端点或 /auth/signed-out。 */
  async signOut(): Promise<void> {
    const stored = ssGet<string | DevIdentity | null>(STORAGE_KEYS.refreshToken, null);
    this.clear(false);
    try {
      this.channel?.postMessage({ t: 'signout' });
    } catch {
      /* 忽略 */
    }
    if (this.mode === 'cognito') {
      if (typeof stored === 'string') await revokeRefreshToken(this.config, stored, this.fetchImpl);
      // Cognito 的登出回调目前登记为平台根地址（infra 20-auth.yaml LogoutURLs）：回来后由标记转到 /auth/signed-out
      ssSet(STORAGE_KEYS.signedOut, true);
      this.loc.assign(logoutUrl(this.config, this.loc));
    } else {
      this.loc.assign('/auth/signed-out');
    }
  }

  /** 读取并清除“刚退出”的标记（根路由据此转到 /auth/signed-out）。 */
  consumeSignedOutFlag(): boolean {
    const v = ssGet<boolean>(STORAGE_KEYS.signedOut, false);
    if (v) ssSet(STORAGE_KEYS.signedOut, undefined);
    return v;
  }

  private clear(elsewhere: boolean): void {
    this.accessToken = null;
    ssSet(STORAGE_KEYS.refreshToken, undefined);
    this.set({ status: 'anonymous', principal: null, signedOutElsewhere: elsewhere });
  }

  private set(patch: Partial<AuthSnapshot>): void {
    this.snap = { ...this.snap, ...patch };
    for (const l of this.listeners) l();
  }
}
