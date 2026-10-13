// backend/src/adapters/auth/cognito.ts —— AuthPort 的 `cognito` 驱动（Amazon Cognito User Pool；02#auth 第 2 节）
//
// - 登录方式（总纲 4.2 AuthPort：flows = null）：浏览器直接与 Cognito 交互，EC2 不经手密码——
//   COGNITO_LOGIN_MODE=sdk：前端动态 import aws-amplify，用 Cognito SDK 直连 User Pool；managed：跳转托管登录页（授权码 + PKCE）。
//   两种子模式都把 access token 交给 API（Authorization: Bearer 或 ca_at Cookie），子模式写进路径头 outcome（auth=cognito:sdk|managed）。
// - 令牌校验：aws-jwt-verify 的 CognitoJwtVerifier（tokenUse=access + clientId，JWKS 进程内缓存，遇到新 kid 自动重新拉取）；
//   本次校验触发了 JWKS 拉取时路径头记为 auth=cognito:jwks-fetch。
// - access token 不含 email：首次见到某个 sub 时用 AdminGetUser 取 email / email_verified / custom:plan（进程内缓存），
//   供 http/middleware/auth.ts 的 JIT 建档（users.auth_subject = sub）。plan 以 users 表为准。
// - Admin*：adminSetGroups、adminDisableUser；Migratable<ExportedIdentity>：count / exportBatch（ListUsers）/ importBatch
//   （bulk 迁移：AdminCreateUser + MessageAction=SUPPRESS，custom:app_uid = users.id）；importIdentities() 额外返回 sub 映射，
//   供 scripts/migrate/auth 回写 users.auth_provider / auth_subject；ensurePasswordReset() 处理迁移用户的首次登录。
// - 权威端口：Cognito / JWKS 不可达时返回 503，绝不回退到本地账号。
import type { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { FetchError, JwtBaseError } from 'aws-jwt-verify/error';
import { SimpleFetcher, type Fetcher } from 'aws-jwt-verify/https';
import type { CognitoJwtVerifierSingleUserPool } from 'aws-jwt-verify/cognito-verifier';
import { SimpleJwksCache, type Jwks } from 'aws-jwt-verify/jwk';
import { HttpError } from '../../errors.js';
import { markPath } from '../../observability/request-context.js';
import type { AdapterMeta, ProbeResult } from '../../ports/common.js';
import type { AuthPort, AuthPublicConfig, EmbeddedAuthFlows, ExportedIdentity, Principal } from '../../ports/auth.js';
import { awsErrorName, describeAwsError, isAwsAccessDenied, isAwsNotFound, loadAwsPackage } from '../aws/clients.js';
import type { AdapterDeps } from '../types.js';

type CognitoConfig = Extract<AdapterDeps['cfg']['auth'], { AUTH_DRIVER: 'cognito' }>;
type CognitoSdk = typeof import('@aws-sdk/client-cognito-identity-provider');
type AttributeList = Array<{ Name?: string; Value?: string }> | undefined;

const DEFAULT_PASSWORD_POLICY: AuthPublicConfig['passwordPolicy'] = { minLength: 8, requireUpper: true, requireDigit: true, requireSymbol: false };
const MANAGED_GROUPS = new Set(['admin', 'member']);

function attr(list: AttributeList, name: string): string | undefined {
  return list?.find((a) => a.Name === name)?.Value;
}

export interface CognitoAuthOptions {
  /** 测试注入：JWKS 拉取器（默认 SimpleFetcher，经 HTTPS 访问 User Pool 的公开 JWKS 端点） */
  jwksFetcher?: Fetcher;
  /** AdminGetUser 结果的缓存时间（默认 600 秒） */
  profileTtlSec?: number;
  /** Admin* 批量操作的并发（默认 4，避免触发 Cognito 的请求配额） */
  adminConcurrency?: number;
}

export interface ImportedIdentity {
  subject: string;
  email: string;
  status: 'created' | 'existing' | 'failed';
  cognitoSub?: string;
  error?: string;
}

interface Profile { email: string; emailVerified: boolean; plan?: string; at: number; ok: boolean }

export class CognitoAuth implements AuthPort {
  readonly meta: AdapterMeta = { module: 'auth', driver: 'cognito', awsService: 'Amazon Cognito User Pool', authoritative: true };
  /** 浏览器直接与 Cognito 交互（Amplify / 托管登录），EC2 不经手密码 */
  readonly flows: EmbeddedAuthFlows | null = null;
  readonly mode: 'sdk' | 'managed';
  readonly region: string;
  readonly userPoolId: string;
  readonly clientId: string;
  readonly issuer: string;
  readonly jwksUri: string;

  private readonly ac: CognitoConfig;
  private readonly jwksCache: SimpleJwksCache;
  private readonly verifier: CognitoJwtVerifierSingleUserPool<{ userPoolId: string; tokenUse: 'access'; clientId: string }>;
  private readonly jwksState: { fetches: number; fetchedAt?: number; lastError?: { at: number; message: string } } = { fetches: 0 };
  private readonly profiles = new Map<string, Profile>();
  private readonly profileTtlMs: number;
  private readonly adminConcurrency: number;
  private sdkPromise?: Promise<CognitoSdk>;
  private passwordPolicy: AuthPublicConfig['passwordPolicy'] = DEFAULT_PASSWORD_POLICY;
  private poolMfa?: AuthPublicConfig['mfa'];

  constructor(protected readonly deps: AdapterDeps, opts: CognitoAuthOptions = {}) {
    const a = deps.cfg.auth;
    if (a.AUTH_DRIVER !== 'cognito') throw new Error(`CognitoAuth 需要 AUTH_DRIVER=cognito（当前 ${a.AUTH_DRIVER}）`);
    this.ac = a;
    this.mode = a.COGNITO_LOGIN_MODE;
    this.userPoolId = a.COGNITO_USER_POOL_ID;
    this.clientId = a.COGNITO_CLIENT_ID;
    this.region = this.userPoolId.split('_')[0] || deps.cfg.core.AWS_REGION;
    const parsed = CognitoJwtVerifier.parseUserPoolId(this.userPoolId);
    this.issuer = parsed.issuer;
    this.jwksUri = parsed.jwksUri;
    this.profileTtlMs = (opts.profileTtlSec ?? 600) * 1000;
    this.adminConcurrency = Math.max(1, opts.adminConcurrency ?? 4);
    const base = opts.jwksFetcher ?? new SimpleFetcher();
    const state = this.jwksState;
    const counting: Fetcher = {
      async fetch(uri, requestOptions, data) {
        try {
          const r = await base.fetch(uri, requestOptions, data);
          state.fetches += 1;
          state.fetchedAt = Date.now();
          delete state.lastError;
          return r;
        } catch (e) {
          state.lastError = { at: Date.now(), message: (e as Error)?.message ?? String(e) };
          throw e;
        }
      },
    };
    this.jwksCache = new SimpleJwksCache({ fetcher: counting });
    this.verifier = CognitoJwtVerifier.create({ userPoolId: this.userPoolId, tokenUse: 'access', clientId: this.clientId }, { jwksCache: this.jwksCache });
  }

  private client(): Promise<CognitoIdentityProviderClient> {
    return this.deps.aws.cognitoIdp();
  }

  private sdk(): Promise<CognitoSdk> {
    this.sdkPromise ??= loadAwsPackage('@aws-sdk/client-cognito-identity-provider', () => import('@aws-sdk/client-cognito-identity-provider'));
    return this.sdkPromise;
  }

  /** 预热：拉取 JWKS、读取密码策略与 MFA 配置。失败只记录（由探针报告），不阻止启动。 */
  async init(): Promise<void> {
    await Promise.allSettled([this.verifier.hydrate(), this.describePool()]);
  }

  // ------------------------------------------------------------------------------------------
  // AuthPort
  // ------------------------------------------------------------------------------------------
  publicConfig(): AuthPublicConfig {
    return {
      driver: 'cognito',
      userPoolId: this.userPoolId,
      userPoolClientId: this.clientId,
      region: this.region,
      ...(this.ac.COGNITO_DOMAIN ? { hostedUiDomain: this.ac.COGNITO_DOMAIN } : {}),
      passwordPolicy: { ...this.passwordPolicy },
      mfa: this.poolMfa ?? (this.ac.AUTH_MFA === 'off' ? 'off' : 'optional'),
    };
  }

  async verifyAccessToken(token: string): Promise<Principal> {
    const fetchesBefore = this.jwksState.fetches;
    const startedAt = Date.now();
    let payload: Record<string, unknown>;
    try {
      payload = (await this.verifier.verify(token)) as unknown as Record<string, unknown>;
    } catch (e) {
      // JWKS 拉不到（网络 / Cognito 故障）是服务不可用，不是令牌无效
      const fetchFailed = e instanceof FetchError || (this.jwksState.lastError !== undefined && this.jwksState.lastError.at >= startedAt);
      if (fetchFailed) throw new HttpError(503, 'AUTH_UNAVAILABLE', `无法获取 Cognito JWKS：${(e as Error)?.message ?? String(e)}`, { module: 'auth', driver: 'cognito' });
      if (e instanceof JwtBaseError) throw new HttpError(401, 'INVALID_TOKEN', e.message);
      throw new HttpError(401, 'INVALID_TOKEN', (e as Error)?.message ?? 'invalid token');
    }
    markPath('auth', `cognito:${this.jwksState.fetches > fetchesBefore ? 'jwks-fetch' : this.mode}`);
    const sub = String(payload.sub ?? '');
    const username = typeof payload.username === 'string' ? payload.username : sub;
    const groups = Array.isArray(payload['cognito:groups']) ? (payload['cognito:groups'] as unknown[]).map(String) : [];
    let email = typeof payload.email === 'string' ? payload.email : '';
    let emailVerified = payload.email_verified === true || payload.email_verified === 'true';
    let plan = typeof payload.plan === 'string' ? payload.plan : undefined;      // Pre Token Generation（V2）可选加入
    if (!email) {
      const p = await this.profile(username);
      email = p.email;
      emailVerified = p.emailVerified;
      plan ??= p.plan;
    }
    return {
      provider: 'cognito',
      subject: sub,
      email,
      emailVerified,
      groups,
      plan: plan ?? 'free',
      expiresAt: Number(payload.exp ?? 0),        // JWT exp（epoch 秒）
    };
  }

  /** AdminGetUser（带缓存）；失败不让请求失败——email 为空时由 JIT 建档按 sub 处理 */
  private async profile(username: string): Promise<Profile> {
    const now = Date.now();
    const hit = this.profiles.get(username);
    if (hit && now - hit.at < (hit.ok ? this.profileTtlMs : 60_000)) return hit;
    let p: Profile;
    try {
      const { AdminGetUserCommand } = await this.sdk();
      const c = await this.client();
      const r = await c.send(new AdminGetUserCommand({ UserPoolId: this.userPoolId, Username: username }));
      const plan = attr(r.UserAttributes, 'custom:plan');
      p = {
        email: attr(r.UserAttributes, 'email') ?? '',
        emailVerified: attr(r.UserAttributes, 'email_verified') === 'true',
        ...(plan ? { plan } : {}),
        at: now, ok: true,
      };
    } catch (e) {
      this.deps.logger?.warn('auth.cognito.profile_lookup_failed', { error: describeAwsError(e) });
      p = { email: '', emailVerified: false, at: now, ok: false };
    }
    this.profiles.set(username, p);
    if (this.profiles.size > 10_000) this.profiles.delete(this.profiles.keys().next().value!);
    return p;
  }

  /** JWKS 由 User Pool 发布（https://cognito-idp.<region>.amazonaws.com/<poolId>/.well-known/jwks.json） */
  jwks(): { keys: Array<Record<string, string>> } | null {
    return null;
  }

  private adminError(op: string, e: unknown): Error {
    if (e instanceof HttpError) return e;
    if (awsErrorName(e) === 'UserNotFoundException') return new HttpError(404, 'USER_NOT_FOUND', `Cognito 中没有该用户（${op}）`);
    return new HttpError(503, 'AUTH_UNAVAILABLE', `Cognito ${op} 失败：${describeAwsError(e)}`, { module: 'auth', driver: 'cognito' });
  }

  /** subject = Cognito sub（以 email 为用户名属性的池中，Admin API 的 Username 参数接受 sub） */
  async adminSetGroups(subject: string, groups: string[]): Promise<void> {
    const { AdminListGroupsForUserCommand, AdminAddUserToGroupCommand, AdminRemoveUserFromGroupCommand } = await this.sdk();
    try {
      const c = await this.client();
      const current = new Set<string>();
      let token: string | undefined;
      do {
        const r = await c.send(new AdminListGroupsForUserCommand({ UserPoolId: this.userPoolId, Username: subject, ...(token ? { NextToken: token } : {}) }));
        for (const g of r.Groups ?? []) if (g.GroupName) current.add(g.GroupName);
        token = r.NextToken;
      } while (token);
      const target = new Set(groups);
      for (const g of target) {
        if (!current.has(g)) await c.send(new AdminAddUserToGroupCommand({ UserPoolId: this.userPoolId, Username: subject, GroupName: g }));
      }
      for (const g of current) {
        if (!target.has(g)) await c.send(new AdminRemoveUserFromGroupCommand({ UserPoolId: this.userPoolId, Username: subject, GroupName: g }));
      }
    } catch (e) {
      throw this.adminError('adminSetGroups', e);
    }
  }

  async adminDisableUser(subject: string): Promise<void> {
    const { AdminDisableUserCommand, AdminUserGlobalSignOutCommand } = await this.sdk();
    try {
      const c = await this.client();
      await c.send(new AdminDisableUserCommand({ UserPoolId: this.userPoolId, Username: subject }));
      // 禁用后再全局登出：refresh token 立即失效；已签发的 access token 在过期前仍能通过本地验签（无状态校验的代价）
      await c.send(new AdminUserGlobalSignOutCommand({ UserPoolId: this.userPoolId, Username: subject })).catch(() => undefined);
    } catch (e) {
      throw this.adminError('adminDisableUser', e);
    }
  }

  /** bulk 迁移用户首次登录：账号仍是 FORCE_CHANGE_PASSWORD / RESET_REQUIRED 时调用 AdminResetUserPassword（此时才发验证码邮件） */
  async ensurePasswordReset(email: string): Promise<'reset-sent' | 'not-needed'> {
    const { AdminGetUserCommand, AdminResetUserPasswordCommand } = await this.sdk();
    try {
      const c = await this.client();
      const u = await c.send(new AdminGetUserCommand({ UserPoolId: this.userPoolId, Username: email }));
      if (u.UserStatus !== 'FORCE_CHANGE_PASSWORD' && u.UserStatus !== 'RESET_REQUIRED') return 'not-needed';
      await c.send(new AdminResetUserPasswordCommand({ UserPoolId: this.userPoolId, Username: email }));
      return 'reset-sent';
    } catch (e) {
      throw this.adminError('ensurePasswordReset', e);
    }
  }

  // ------------------------------------------------------------------------------------------
  // Migratable<ExportedIdentity>（scripts/migrate/auth；默认 AUTH_MIGRATION=bulk，密码不迁移）
  // ------------------------------------------------------------------------------------------
  async count(): Promise<number> {
    const pool = await this.describePool();
    return pool.estimatedUsers;
  }

  async exportBatch(cursor?: string, limit = 60): Promise<{ items: ExportedIdentity[]; next?: string }> {
    const { ListUsersCommand, AdminListGroupsForUserCommand } = await this.sdk();
    try {
      const c = await this.client();
      const r = await c.send(new ListUsersCommand({ UserPoolId: this.userPoolId, Limit: Math.max(1, Math.min(60, limit)), ...(cursor ? { PaginationToken: cursor } : {}) }));
      const users = (r.Users ?? []).filter((u) => u.Username);
      const items = await mapLimit(users, this.adminConcurrency, async (u): Promise<ExportedIdentity> => {
        const g = await c.send(new AdminListGroupsForUserCommand({ UserPoolId: this.userPoolId, Username: u.Username! }));
        const sub = attr(u.Attributes, 'sub') ?? u.Username!;
        return {
          subject: attr(u.Attributes, 'custom:app_uid') ?? sub,
          email: attr(u.Attributes, 'email') ?? '',
          emailVerified: attr(u.Attributes, 'email_verified') === 'true',
          groups: (g.Groups ?? []).map((x) => x.GroupName).filter((x): x is string => Boolean(x)),
          plan: attr(u.Attributes, 'custom:plan') ?? 'free',
          mfaEnabled: (u.MFAOptions?.length ?? 0) > 0,
        };
      });
      return { items, ...(r.PaginationToken ? { next: r.PaginationToken } : {}) };
    } catch (e) {
      throw this.adminError('ListUsers', e);
    }
  }

  async importBatch(items: ExportedIdentity[]): Promise<{ written: number; skipped: number }> {
    const results = await this.importIdentities(items);
    const failed = results.filter((r) => r.status === 'failed');
    if (failed.length) {
      throw new HttpError(503, 'AUTH_IMPORT_FAILED', `Cognito 导入失败 ${failed.length} 条：${failed.slice(0, 3).map((f) => `${f.email}（${f.error}）`).join('；')}`);
    }
    return { written: results.filter((r) => r.status === 'created').length, skipped: results.filter((r) => r.status === 'existing').length };
  }

  /**
   * bulk 迁移的核心（幂等）：AdminCreateUser（MessageAction=SUPPRESS 不群发邀请；email_verified=true；custom:app_uid / custom:legacy_id =
   * users.id；custom:plan），已存在则读出 sub；再把 admin / member 组补齐。返回每个身份的 Cognito sub，供迁移脚本回写 users 表。
   */
  async importIdentities(items: ExportedIdentity[]): Promise<ImportedIdentity[]> {
    const { AdminCreateUserCommand, AdminGetUserCommand, AdminAddUserToGroupCommand } = await this.sdk();
    const c = await this.client();
    return mapLimit(items, this.adminConcurrency, async (item): Promise<ImportedIdentity> => {
      const email = item.email.trim().toLowerCase();
      let status: ImportedIdentity['status'] = 'created';
      let attrs: AttributeList;
      try {
        try {
          const r = await c.send(new AdminCreateUserCommand({
            UserPoolId: this.userPoolId,
            Username: email,
            MessageAction: 'SUPPRESS',
            UserAttributes: [
              { Name: 'email', Value: email },
              { Name: 'email_verified', Value: 'true' },
              { Name: 'custom:app_uid', Value: item.subject },
              { Name: 'custom:legacy_id', Value: item.subject },
              { Name: 'custom:plan', Value: item.plan || 'free' },
            ],
          }));
          attrs = r.User?.Attributes;
        } catch (e) {
          if (awsErrorName(e) !== 'UsernameExistsException') throw e;
          status = 'existing';
          const u = await c.send(new AdminGetUserCommand({ UserPoolId: this.userPoolId, Username: email }));
          attrs = u.UserAttributes;
        }
        const cognitoSub = attr(attrs, 'sub');
        for (const g of item.groups.filter((x) => MANAGED_GROUPS.has(x))) {
          await c.send(new AdminAddUserToGroupCommand({ UserPoolId: this.userPoolId, Username: email, GroupName: g }));
        }
        return { subject: item.subject, email, status, ...(cognitoSub ? { cognitoSub } : {}) };
      } catch (e) {
        return { subject: item.subject, email, status: 'failed', error: describeAwsError(e) };
      }
    });
  }

  // ------------------------------------------------------------------------------------------
  // 探针（02#auth 第 10 节）
  // ------------------------------------------------------------------------------------------
  private async describePool(): Promise<{ name?: string; status?: string; estimatedUsers: number; mfa?: string; tier?: string; arn?: string }> {
    const { DescribeUserPoolCommand } = await this.sdk();
    const c = await this.client();
    const r = await c.send(new DescribeUserPoolCommand({ UserPoolId: this.userPoolId }));
    const p = r.UserPool;
    const pp = p?.Policies?.PasswordPolicy;
    if (pp) {
      this.passwordPolicy = {
        minLength: pp.MinimumLength ?? DEFAULT_PASSWORD_POLICY.minLength,
        requireUpper: pp.RequireUppercase ?? DEFAULT_PASSWORD_POLICY.requireUpper,
        requireDigit: pp.RequireNumbers ?? DEFAULT_PASSWORD_POLICY.requireDigit,
        requireSymbol: pp.RequireSymbols ?? DEFAULT_PASSWORD_POLICY.requireSymbol,
      };
    }
    if (p?.MfaConfiguration) this.poolMfa = p.MfaConfiguration === 'ON' ? 'required' : p.MfaConfiguration === 'OPTIONAL' ? 'optional' : 'off';
    return {
      ...(p?.Name ? { name: p.Name } : {}),
      ...(p?.Status ? { status: p.Status } : {}),
      estimatedUsers: p?.EstimatedNumberOfUsers ?? 0,
      ...(p?.MfaConfiguration ? { mfa: p.MfaConfiguration } : {}),
      ...(p?.UserPoolTier ? { tier: p.UserPoolTier } : {}),
      ...(p?.Arn ? { arn: p.Arn } : {}),
    };
  }

  private jwksAgeText(): string {
    if (!this.jwksState.fetchedAt) return 'JWKS 尚未拉取';
    const min = Math.round((Date.now() - this.jwksState.fetchedAt) / 60_000);
    return `JWKS 缓存 ${min} 分钟前刷新`;
  }

  async probe(opts: { deep?: boolean } = {}): Promise<ProbeResult> {
    const t0 = performance.now();
    let pool: Awaited<ReturnType<CognitoAuth['describePool']>>;
    try {
      pool = await this.describePool();
    } catch (e) {
      const why = isAwsNotFound(e) ? 'User Pool 不存在' : isAwsAccessDenied(e) ? '无权限（检查 PolicyArn 的 cognito-idp:DescribeUserPool）' : describeAwsError(e);
      return { status: 'error', detail: `DescribeUserPool 失败：${why}`, confidence: 'confirmed', data: { userPoolId: this.userPoolId } };
    }
    const problems: string[] = [];
    let status: ProbeResult['status'] = 'ok';
    const data: Record<string, unknown> = {
      userPoolId: this.userPoolId, clientId: this.clientId, issuer: this.issuer, jwksUri: this.jwksUri, mode: this.mode,
      estimatedUsers: pool.estimatedUsers, ...(pool.tier ? { tier: pool.tier } : {}), ...(pool.arn ? { arn: pool.arn } : {}),
      jwksFetches: this.jwksState.fetches,
      ...(this.jwksState.fetchedAt ? { jwksFetchedAt: new Date(this.jwksState.fetchedAt).toISOString() } : {}),
    };
    if (opts.deep) {
      try {
        await this.jwksCache.getJwks(this.jwksUri);          // 强制重新拉取
      } catch {
        /* 结果记录在 jwksState.lastError */
      }
      const client = await this.describeClient().catch((e: unknown) => ({ error: describeAwsError(e) }));
      Object.assign(data, { appClient: client });
      if ('hasSecret' in client) {
        if (this.mode === 'sdk' && client.hasSecret) {
          status = 'degraded';
          problems.push('App Client 带有密钥：浏览器里的 Amplify（公有客户端）无法使用它');
        }
        if (this.mode === 'managed') {
          const expected = `${this.deps.cfg.core.APP_BASE_URL.replace(/\/$/, '')}/api/auth/callback`;
          if (!client.callbackUrls.includes(expected)) {
            status = 'degraded';
            problems.push(`回调地址未包含 ${expected}（入口 URL 变化后 auth 栈未更新？）`);
          }
        }
      }
    }
    if (this.jwksState.lastError) {
      if (this.jwksState.fetchedAt) {
        status = 'degraded';
        problems.push(`JWKS 刷新失败但缓存可用：${this.jwksState.lastError.message}`);
      } else {
        status = 'error';
        problems.push(`无法拉取 JWKS，令牌无法校验：${this.jwksState.lastError.message}`);
      }
    }
    const modeText = this.mode === 'managed' ? '托管登录（COGNITO_LOGIN_MODE=managed）' : '浏览器 SDK 直连（COGNITO_LOGIN_MODE=sdk）';
    const detail = `User Pool ${this.userPoolId}${pool.status ? `（${pool.status}）` : ''} · ${modeText} · ${this.jwksAgeText()}` +
      `${problems.length ? ` · ${problems.join('；')}` : ''}`;
    return { status, detail, latencyMs: Math.round((performance.now() - t0) * 10) / 10, confidence: 'confirmed', data };
  }

  private async describeClient(): Promise<{ hasSecret: boolean; callbackUrls: string[]; explicitAuthFlows: string[]; oauthFlows: string[] }> {
    const { DescribeUserPoolClientCommand } = await this.sdk();
    const c = await this.client();
    const r = await c.send(new DescribeUserPoolClientCommand({ UserPoolId: this.userPoolId, ClientId: this.clientId }));
    const uc = r.UserPoolClient;
    return {
      hasSecret: Boolean(uc?.ClientSecret),
      callbackUrls: uc?.CallbackURLs ?? [],
      explicitAuthFlows: (uc?.ExplicitAuthFlows ?? []).map(String),
      oauthFlows: (uc?.AllowedOAuthFlows ?? []).map(String),
    };
  }

  /** 测试与预热：直接放入 JWKS（例如从文件读取），不发起网络请求 */
  cacheJwks(jwks: { keys: Array<Record<string, unknown>> }): void {
    this.jwksCache.addJwks(this.jwksUri, jwks as unknown as Jwks);
    this.jwksState.fetchedAt ??= Date.now();
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]!);
    }
  });
  await Promise.all(workers);
  return out;
}
