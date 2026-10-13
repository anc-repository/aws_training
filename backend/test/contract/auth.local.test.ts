// AuthPort · local 驱动：契约 + ES256 声明、密钥轮换（上一版本 kid）、过期、F3 域名白名单、禁用、迁移导入导出
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { decodeProtectedHeader, decodeJwt, SignJWT } from 'jose';
import { afterEach, describe, expect, it } from 'vitest';
import { FileConfig } from '../../src/adapters/config/file.js';
import { OutboxEmail } from '../../src/adapters/email/outbox.js';
import { LocalCrypto } from '../../src/adapters/kms/local.js';
import { ACCESS_AUDIENCE, LocalAuth } from '../../src/adapters/auth/local.js';
import { loadSigningKey } from '../../src/adapters/auth/local/keys.js';
import { EnvSecrets } from '../../src/adapters/secrets/env.js';
import { generateEs256Pem } from '../helpers/identity-harness.js';
import { describeAuthContract } from './auth.contract.js';
import { makeLocalDeps } from './_local-deps.js';

const PASSWORD = 'Correct-horse-42';

async function localAuth(opts: Parameters<typeof makeLocalDeps>[0] = {}) {
  const l = await makeLocalDeps(opts);
  l.deps.secrets = new EnvSecrets(l.deps);
  const runtime = new FileConfig(l.deps);
  await runtime.init();
  l.deps.runtime = runtime;
  l.deps.crypto = new LocalCrypto(l.deps);
  l.deps.email = new OutboxEmail(l.deps);
  const auth = new LocalAuth(l.deps);
  await auth.init().catch(() => undefined);
  const close = async () => {
    await runtime.close();
    await l.close();
  };
  return { l, auth, close };
}

async function registerAndLogin(auth: LocalAuth, email = 'user@example.com') {
  const { subject } = await auth.flows.register({ email, password: PASSWORD, displayName: 'User' });
  const r = await auth.flows.login(email, PASSWORD);
  if (r.kind !== 'tokens') throw new Error('expected tokens');
  return { subject, tokens: r.tokens };
}

describeAuthContract('local', async () => {
  const { auth, close } = await localAuth();
  return {
    port: auth,
    validToken: async () => {
      const email = `c${Math.random().toString(36).slice(2, 8)}@example.com`;
      const { subject, tokens } = await registerAndLogin(auth, email);
      return { token: tokens.accessToken, subject, email };
    },
    cleanup: close,
  };
});

describe('LocalAuth（本地实现特有）', () => {
  let ctx: Awaited<ReturnType<typeof localAuth>> | undefined;
  afterEach(async () => {
    await ctx?.close();
    ctx = undefined;
  });

  it('访问令牌：ES256 + kid；iss = APP_BASE_URL 的 origin，aud=cloudalbum；带 sub、email、groups、plan、tv、ev、token_use', async () => {
    ctx = await localAuth();
    const { subject, tokens } = await registerAndLogin(ctx.auth);
    expect(tokens.expiresIn).toBe(900);
    const header = decodeProtectedHeader(tokens.accessToken);
    expect(header).toMatchObject({ alg: 'ES256', typ: 'JWT' });
    expect(header.kid).toBe(ctx.auth.jwks()!.keys[0]!.kid);
    const claims = decodeJwt(tokens.accessToken);
    expect(claims).toMatchObject({ sub: subject, iss: 'http://localhost:3000', aud: ACCESS_AUDIENCE, email: 'user@example.com', groups: ['member'],
      plan: 'free', tv: 0, ev: false, token_use: 'access' });
    expect(Number(claims.exp) - Number(claims.iat)).toBe(900);
    const p = await ctx.auth.verifyAccessToken(tokens.accessToken);
    expect(p).toMatchObject({ provider: 'local', subject, emailVerified: false, groups: ['member'] });
  });

  it('过期的令牌、别的私钥签的令牌被拒绝', async () => {
    ctx = await localAuth();
    const { subject } = await registerAndLogin(ctx.auth);
    const pem = readFileSync(path.join(ctx.l.envDir, 'keys', 'jwt-es256.pem'), 'utf8');
    const key = await loadSigningKey(pem);
    const sign = (k: typeof key, exp: number) => new SignJWT({ token_use: 'access', tv: 0 }).setProtectedHeader({ alg: 'ES256', kid: k.kid })
      .setSubject(subject).setIssuer('http://localhost:3000').setAudience(ACCESS_AUDIENCE).setIssuedAt(exp - 900).setExpirationTime(exp).sign(k.privateKey);
    await expect(ctx.auth.verifyAccessToken(await sign(key, Math.floor(Date.now() / 1000) - 60))).rejects.toMatchObject({ status: 401, message: '访问令牌已过期' });
    const stranger = await loadSigningKey(generateEs256Pem());
    await expect(ctx.auth.verifyAccessToken(await sign(stranger, Math.floor(Date.now() / 1000) + 60))).rejects.toMatchObject({ status: 401 });
    await expect(ctx.auth.verifyAccessToken(await sign({ ...stranger, kid: key.kid }, Math.floor(Date.now() / 1000) + 60))).rejects.toMatchObject({ status: 401 });
  });

  it('密钥轮换：上一版本私钥 jwt-es256.prev.pem 仍可验签并出现在 JWKS；未知 kid 触发一次重新加载', async () => {
    ctx = await localAuth();
    const { tokens: oldTokens } = await registerAndLogin(ctx.auth);
    const keys = path.join(ctx.l.envDir, 'keys');
    renameSync(path.join(keys, 'jwt-es256.pem'), path.join(keys, 'jwt-es256.prev.pem'));
    writeFileSync(path.join(keys, 'jwt-es256.pem'), generateEs256Pem());
    // 另一个实例（重启后的进程）：用新私钥签发，JWKS 发布两个 kid
    const rotated = new LocalAuth({ ...ctx.l.deps, secrets: new EnvSecrets(ctx.l.deps) });
    await rotated.init();
    expect(rotated.jwks()!.keys).toHaveLength(2);
    expect((await rotated.probe()).detail).toContain('2 个 kid');
    expect((await rotated.verifyAccessToken(oldTokens.accessToken)).email).toBe('user@example.com');
    const fresh = await rotated.flows.login('user@example.com', PASSWORD);
    if (fresh.kind !== 'tokens') throw new Error('expected tokens');
    // 旧实例还不认识新 kid：超过频率限制后会强制刷新一次密钥
    (ctx.auth as unknown as { lastKeyLoadAt: number }).lastKeyLoadAt = 0;
    expect((await ctx.auth.verifyAccessToken(fresh.tokens.accessToken)).email).toBe('user@example.com');
  });

  it('上一版本私钥损坏 → 探针 degraded；当前私钥缺失 → 探针 error，jwks() 503', async () => {
    ctx = await localAuth();
    writeFileSync(path.join(ctx.l.envDir, 'keys', 'jwt-es256.prev.pem'), 'not a pem');
    await ctx.auth.loadKeys();
    expect((await ctx.auth.probe()).status).toBe('degraded');
    await ctx.close();

    ctx = await localAuth({ withKey: false });
    expect((await ctx.auth.probe()).status).toBe('error');
    expect(() => ctx!.auth.jwks()).toThrow(expect.objectContaining({ status: 503 }));
  });

  it('F3：运行时配置 allowedEmailDomains 限制注册域名（含子域名）', async () => {
    ctx = await localAuth({ runtime: { allowedEmailDomains: ['example.com'] } });
    await expect(ctx.auth.flows.register({ email: 'x@other.org', password: PASSWORD, displayName: 'x' })).rejects.toMatchObject({ status: 403, code: 'EMAIL_DOMAIN_NOT_ALLOWED' });
    await expect(ctx.auth.flows.register({ email: 'x@mail.example.com', password: PASSWORD, displayName: 'x' })).resolves.toMatchObject({ needsConfirmation: true });
  });

  it('adminSetGroups / adminDisableUser 立即生效', async () => {
    ctx = await localAuth();
    const { subject, tokens } = await registerAndLogin(ctx.auth);
    await ctx.auth.adminSetGroups(subject, ['admin']);
    expect((await ctx.auth.verifyAccessToken(tokens.accessToken)).groups).toEqual(['admin']);
    await ctx.auth.adminDisableUser(subject);
    await expect(ctx.auth.verifyAccessToken(tokens.accessToken)).rejects.toMatchObject({ status: 401 });
    await expect(ctx.auth.flows.refresh(tokens.refreshToken)).rejects.toMatchObject({ status: 401 });
  });

  it('Migratable：exportBatch 分页、不含密码哈希；importBatch 幂等（回滚时导入的用户没有本地密码）', async () => {
    ctx = await localAuth();
    for (const n of [1, 2, 3]) await ctx.auth.flows.register({ email: `m${n}@example.com`, password: PASSWORD, displayName: `m${n}` });
    expect(await ctx.auth.count()).toBe(3);
    const p1 = await ctx.auth.exportBatch(undefined, 2);
    expect(p1.items).toHaveLength(2);
    expect(p1.next).toBeTruthy();
    const p2 = await ctx.auth.exportBatch(p1.next, 2);
    expect(p2.items).toHaveLength(1);
    expect(p2.next).toBeUndefined();
    expect(JSON.stringify([...p1.items, ...p2.items])).not.toMatch(/argon2/);
    const imported = [{ subject: 'cognito-sub-1', email: 'from-cognito@example.com', emailVerified: true, groups: ['member'], plan: 'pro', mfaEnabled: false }];
    expect(await ctx.auth.importBatch([...imported, ...p1.items])).toEqual({ written: 1, skipped: 2 });
    expect(await ctx.auth.importBatch(imported)).toEqual({ written: 0, skipped: 1 });
    const row = await ctx.l.db('users').where({ email: 'from-cognito@example.com' }).first();
    expect(row).toMatchObject({ password_hash: null, plan: 'pro', auth_provider: 'local' });
    expect(await ctx.l.db('albums').where({ owner_id: row.id, is_default: true }).first()).toBeTruthy();
  });

  it('resendCode / forgotPassword 对不存在的邮箱静默；同类旧验证码在重发后作废', async () => {
    ctx = await localAuth();
    await expect(ctx.auth.flows.resendCode('nobody@example.com')).resolves.toBeUndefined();
    await expect(ctx.auth.flows.forgotPassword('nobody@example.com')).resolves.toBeUndefined();
    await ctx.auth.flows.register({ email: 'r@example.com', password: PASSWORD, displayName: 'r' });
    await ctx.auth.flows.resendCode('r@example.com');
    expect(await ctx.l.db('auth_tokens').where({ type: 'verify_email' })).toHaveLength(1);
    expect(await ctx.l.db('outbox_emails').where({ category: 'verification' })).toHaveLength(2);
  });
});
