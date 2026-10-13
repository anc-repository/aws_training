// auth=cognito：aws-jwt-verify 校验（本地 RS256 密钥 + 注入的 JWKS 拉取器，不访问网络）、JIT 资料查询、Admin*、bulk 迁移、探针
import {
  AdminAddUserToGroupCommand, AdminCreateUserCommand, AdminDisableUserCommand, AdminGetUserCommand, AdminListGroupsForUserCommand,
  AdminRemoveUserFromGroupCommand, AdminResetUserPasswordCommand, AdminUserGlobalSignOutCommand, CognitoIdentityProviderClient,
  DescribeUserPoolClientCommand, DescribeUserPoolCommand, ListUsersCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { mockClient } from 'aws-sdk-client-mock';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { CognitoAuth } from '../../../src/adapters/auth/cognito.js';
import { createRequestContext, runWithContext } from '../../../src/observability/request-context.js';
import { ENABLE } from '../../helpers/config.js';
import { awsError, makeDeps } from './helpers.js';

const POOL = ENABLE.cognito.COGNITO_USER_POOL_ID;
const CLIENT = ENABLE.cognito.COGNITO_CLIENT_ID;
const ISSUER = `https://cognito-idp.ap-northeast-1.amazonaws.com/${POOL}`;
const env = { ...ENABLE.iamRole, ...ENABLE.cognito };
const idp = mockClient(CognitoIdentityProviderClient);
afterEach(() => idp.reset());

let privateKey: CryptoKey;
let jwk: JWK;
beforeAll(async () => {
  const kp = await generateKeyPair('RS256', { extractable: true });
  privateKey = kp.privateKey as CryptoKey;
  jwk = { ...(await exportJWK(kp.publicKey)), kid: 'kid-1', alg: 'RS256', use: 'sig' };
});

function fetcher(opts: { fail?: boolean } = {}) {
  const calls: string[] = [];
  return {
    calls,
    fetch: async (uri: string) => {
      calls.push(uri);
      if (opts.fail) throw new Error('getaddrinfo ENOTFOUND cognito-idp');
      return new TextEncoder().encode(JSON.stringify({ keys: [jwk] })).buffer as ArrayBuffer;
    },
  };
}

async function token(claims: Record<string, unknown> = {}, opts: { exp?: string; kid?: string } = {}): Promise<string> {
  return new SignJWT({ token_use: 'access', client_id: CLIENT, username: 'user-uuid-1', 'cognito:groups': ['admin'], scope: 'aws.cognito.signin.user.admin', ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: opts.kid ?? 'kid-1' })
    .setIssuer(ISSUER).setSubject('sub-123').setIssuedAt().setExpirationTime(opts.exp ?? '10m')
    .sign(privateKey);
}

function newAuth(extraEnv: Record<string, string> = {}, f = fetcher()) {
  return { auth: new CognitoAuth(makeDeps({ ...env, ...extraEnv }), { jwksFetcher: f }), f };
}

describe('CognitoAuth.verifyAccessToken', () => {
  it('校验通过：首次拉取 JWKS（auth=cognito:jwks-fetch），之后走缓存（auth=cognito:sdk）；email 由 AdminGetUser 补齐', async () => {
    idp.on(AdminGetUserCommand).resolves({ Username: 'user-uuid-1', UserAttributes: [
      { Name: 'email', Value: 'a@example.com' }, { Name: 'email_verified', Value: 'true' }, { Name: 'custom:plan', Value: 'pro' },
    ] });
    const { auth, f } = newAuth();
    const t = await token();
    const c1 = createRequestContext();
    const p = await runWithContext(c1, () => auth.verifyAccessToken(t));
    expect(p).toMatchObject({ provider: 'cognito', subject: 'sub-123', email: 'a@example.com', emailVerified: true, groups: ['admin'], plan: 'pro' });
    expect(p.expiresAt).toBeGreaterThan(Date.now() / 1000);
    expect(c1.path.get('auth')).toBe('cognito:jwks-fetch');
    expect(f.calls).toEqual([`${ISSUER}/.well-known/jwks.json`]);
    const c2 = createRequestContext();
    await runWithContext(c2, () => auth.verifyAccessToken(t));
    expect(c2.path.get('auth')).toBe('cognito:sdk');
    expect(f.calls).toHaveLength(1);
    expect(idp.commandCalls(AdminGetUserCommand)).toHaveLength(1);       // 资料有缓存
  });

  it('managed 子模式写进路径头 outcome；token 自带 email / plan 时不调用 AdminGetUser', async () => {
    const { auth } = newAuth({ COGNITO_LOGIN_MODE: 'managed' });
    auth.cacheJwks({ keys: [jwk as Record<string, unknown>] });
    const ctx = createRequestContext();
    const p = await runWithContext(ctx, async () => auth.verifyAccessToken(await token({ email: 'b@example.com', email_verified: true, plan: 'free' })));
    expect(p.email).toBe('b@example.com');
    expect(ctx.path.get('auth')).toBe('cognito:managed');
    expect(idp.commandCalls(AdminGetUserCommand)).toHaveLength(0);
  });

  it('拒绝：过期、ID token（token_use=id）、其他 client_id、签名被篡改 → 401', async () => {
    const { auth } = newAuth();
    auth.cacheJwks({ keys: [jwk as Record<string, unknown>] });
    await expect(auth.verifyAccessToken(await token({}, { exp: '-1m' }))).rejects.toMatchObject({ status: 401 });
    await expect(auth.verifyAccessToken(await token({ token_use: 'id' }))).rejects.toMatchObject({ status: 401 });
    await expect(auth.verifyAccessToken(await token({ client_id: 'other' }))).rejects.toMatchObject({ status: 401 });
    const t = await token();
    await expect(auth.verifyAccessToken(`${t.slice(0, -4)}AAAA`)).rejects.toMatchObject({ status: 401 });
    await expect(auth.verifyAccessToken('not-a-jwt')).rejects.toMatchObject({ status: 401, code: 'INVALID_TOKEN' });
  });

  it('JWKS 拉取失败 → 503（权威端口，不回退本地账号）', async () => {
    const { auth } = newAuth({}, fetcher({ fail: true }));
    await expect(auth.verifyAccessToken(await token())).rejects.toMatchObject({ status: 503, code: 'AUTH_UNAVAILABLE' });
  });

  it('AdminGetUser 失败不让请求失败（email 为空，交给 JIT 按 sub 处理）', async () => {
    idp.on(AdminGetUserCommand).rejects(awsError('AccessDeniedException', 400));
    const { auth } = newAuth();
    auth.cacheJwks({ keys: [jwk as Record<string, unknown>] });
    const p = await auth.verifyAccessToken(await token());
    expect(p).toMatchObject({ subject: 'sub-123', email: '', plan: 'free' });
  });
});

describe('CognitoAuth 其他端口方法', () => {
  it('flows = null（浏览器直接与 Cognito 交互），jwks() = null；publicConfig 来自配置与 DescribeUserPool', async () => {
    idp.on(DescribeUserPoolCommand).resolves({ UserPool: { Id: POOL, MfaConfiguration: 'OPTIONAL', Policies: { PasswordPolicy: { MinimumLength: 12, RequireUppercase: true, RequireNumbers: true, RequireSymbols: true } } } });
    const { auth } = newAuth({ COGNITO_DOMAIN: 'cloudalbum-lab-123.auth.ap-northeast-1.amazoncognito.com' }, { fetch: async () => new TextEncoder().encode(JSON.stringify({ keys: [jwk] })).buffer as ArrayBuffer });
    expect(auth.flows).toBeNull();
    expect(auth.jwks()).toBeNull();
    await auth.init();
    expect(auth.publicConfig()).toEqual({
      driver: 'cognito', userPoolId: POOL, userPoolClientId: CLIENT, region: 'ap-northeast-1',
      hostedUiDomain: 'cloudalbum-lab-123.auth.ap-northeast-1.amazoncognito.com',
      passwordPolicy: { minLength: 12, requireUpper: true, requireDigit: true, requireSymbol: true }, mfa: 'optional',
    });
  });

  it('adminSetGroups 按差集增删组；adminDisableUser 禁用并全局登出', async () => {
    idp.on(AdminListGroupsForUserCommand).resolves({ Groups: [{ GroupName: 'member' }, { GroupName: 'legacy' }] });
    idp.on(AdminAddUserToGroupCommand).resolves({});
    idp.on(AdminRemoveUserFromGroupCommand).resolves({});
    const { auth } = newAuth();
    await auth.adminSetGroups('sub-123', ['admin', 'member']);
    expect(idp.commandCalls(AdminAddUserToGroupCommand).map((c) => c.args[0].input.GroupName)).toEqual(['admin']);
    expect(idp.commandCalls(AdminRemoveUserFromGroupCommand).map((c) => c.args[0].input.GroupName)).toEqual(['legacy']);
    idp.on(AdminDisableUserCommand).resolves({});
    idp.on(AdminUserGlobalSignOutCommand).resolves({});
    await auth.adminDisableUser('sub-123');
    expect(idp.commandCalls(AdminUserGlobalSignOutCommand)).toHaveLength(1);
    idp.on(AdminDisableUserCommand).rejects(awsError('UserNotFoundException', 400));
    await expect(auth.adminDisableUser('nobody')).rejects.toMatchObject({ status: 404 });
  });

  it('bulk 迁移：AdminCreateUser（SUPPRESS、custom:app_uid）幂等，已存在则读出 sub；同步 admin / member 组', async () => {
    idp.on(AdminCreateUserCommand)
      .resolvesOnce({ User: { Username: 'a@example.com', Attributes: [{ Name: 'sub', Value: 'sub-a' }] } })
      .rejectsOnce(awsError('UsernameExistsException', 400))
      .rejects(awsError('LimitExceededException', 400));
    idp.on(AdminGetUserCommand).resolves({ UserAttributes: [{ Name: 'sub', Value: 'sub-b' }] });
    idp.on(AdminAddUserToGroupCommand).resolves({});
    const { auth } = newAuth();
    const items = [
      { subject: 'uid-a', email: 'A@example.com', emailVerified: true, groups: ['admin', 'weird'], plan: 'pro', mfaEnabled: false },
      { subject: 'uid-b', email: 'b@example.com', emailVerified: false, groups: ['member'], plan: 'free', mfaEnabled: false },
      { subject: 'uid-c', email: 'c@example.com', emailVerified: true, groups: [], plan: 'free', mfaEnabled: false },
    ];
    const r = await auth.importIdentities(items);
    expect(r).toEqual([
      { subject: 'uid-a', email: 'a@example.com', status: 'created', cognitoSub: 'sub-a' },
      { subject: 'uid-b', email: 'b@example.com', status: 'existing', cognitoSub: 'sub-b' },
      expect.objectContaining({ subject: 'uid-c', status: 'failed' }),
    ]);
    const created = idp.commandCalls(AdminCreateUserCommand)[0]!.args[0].input;
    expect(created.MessageAction).toBe('SUPPRESS');
    expect(created.UserAttributes).toEqual(expect.arrayContaining([{ Name: 'custom:app_uid', Value: 'uid-a' }, { Name: 'email_verified', Value: 'true' }]));
    expect(idp.commandCalls(AdminAddUserToGroupCommand).map((c) => c.args[0].input.GroupName).sort()).toEqual(['admin', 'member']);
    await expect(auth.importBatch(items.slice(2))).rejects.toMatchObject({ code: 'AUTH_IMPORT_FAILED' });
  });

  it('exportBatch（ListUsers + 组）与 count（EstimatedNumberOfUsers）', async () => {
    idp.on(ListUsersCommand).resolves({ Users: [{ Username: 'u1', Attributes: [
      { Name: 'sub', Value: 'sub-1' }, { Name: 'email', Value: 'x@example.com' }, { Name: 'email_verified', Value: 'true' }, { Name: 'custom:app_uid', Value: 'uid-1' },
    ] }], PaginationToken: 'next-1' });
    idp.on(AdminListGroupsForUserCommand).resolves({ Groups: [{ GroupName: 'member' }] });
    idp.on(DescribeUserPoolCommand).resolves({ UserPool: { EstimatedNumberOfUsers: 7 } });
    const { auth } = newAuth();
    expect(await auth.exportBatch()).toEqual({
      items: [{ subject: 'uid-1', email: 'x@example.com', emailVerified: true, groups: ['member'], plan: 'free', mfaEnabled: false }],
      next: 'next-1',
    });
    expect(await auth.count()).toBe(7);
  });

  it('ensurePasswordReset：只对 FORCE_CHANGE_PASSWORD / RESET_REQUIRED 发重置码', async () => {
    idp.on(AdminGetUserCommand).resolvesOnce({ UserStatus: 'FORCE_CHANGE_PASSWORD' }).resolves({ UserStatus: 'CONFIRMED' });
    idp.on(AdminResetUserPasswordCommand).resolves({});
    const { auth } = newAuth();
    expect(await auth.ensurePasswordReset('a@example.com')).toBe('reset-sent');
    expect(await auth.ensurePasswordReset('a@example.com')).toBe('not-needed');
    expect(idp.commandCalls(AdminResetUserPasswordCommand)).toHaveLength(1);
  });
});

describe('CognitoAuth 探针', () => {
  it('DescribeUserPool 成功 → ok；User Pool 不存在 → error', async () => {
    idp.on(DescribeUserPoolCommand).resolves({ UserPool: { Id: POOL, Status: 'Enabled', EstimatedNumberOfUsers: 3 } });
    const { auth } = newAuth();
    auth.cacheJwks({ keys: [jwk as Record<string, unknown>] });
    const ok = await auth.probe();
    expect(ok.status).toBe('ok');
    expect(ok.detail).toContain(`User Pool ${POOL}`);
    expect(ok.detail).toContain('JWKS 缓存 0 分钟前刷新');
    idp.on(DescribeUserPoolCommand).rejects(awsError('ResourceNotFoundException', 400));
    const bad = await auth.probe();
    expect(bad.status).toBe('error');
    expect(bad.detail).toContain('User Pool 不存在');
  });

  it('JWKS 刷新失败但缓存可用 → degraded；从未拉到 JWKS → error', async () => {
    idp.on(DescribeUserPoolCommand).resolves({ UserPool: { Id: POOL } });
    const failing = fetcher({ fail: true });
    const { auth } = newAuth({}, failing);
    await auth.init();
    expect((await auth.probe()).status).toBe('error');
    auth.cacheJwks({ keys: [jwk as Record<string, unknown>] });
    const deep = await auth.probe({ deep: true });
    expect(deep.status).toBe('degraded');
    expect(deep.detail).toContain('JWKS 刷新失败但缓存可用');
  });

  it('深度探针：sdk 子模式下 App Client 带密钥 → degraded（浏览器 Amplify 无法使用）；managed 核对回调地址', async () => {
    idp.on(DescribeUserPoolCommand).resolves({ UserPool: { Id: POOL } });
    idp.on(DescribeUserPoolClientCommand).resolves({ UserPoolClient: { ClientId: CLIENT, ClientSecret: 's3cr3t', CallbackURLs: ['http://localhost:3000/api/auth/callback'] } });
    const sdk = newAuth();
    sdk.auth.cacheJwks({ keys: [jwk as Record<string, unknown>] });
    const r = await sdk.auth.probe({ deep: true });
    expect(r.status).toBe('degraded');
    expect(r.detail).toContain('App Client 带有密钥');
    const managed = newAuth({ COGNITO_LOGIN_MODE: 'managed', APP_BASE_URL: 'https://album.example.com' });
    managed.auth.cacheJwks({ keys: [jwk as Record<string, unknown>] });
    const m = await managed.auth.probe({ deep: true });
    expect(m.detail).toContain('回调地址未包含 https://album.example.com/api/auth/callback');
  });
});
