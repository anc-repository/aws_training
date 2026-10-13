// local-identity 的 HTTP 流程（L0 冒烟测试第 2 条的应用侧）：注册 → /me/outbox 读验证邮件 → 验证 → 登录 → 刷新 → 登出；
// 受限会话、CSRF、锁定、MFA、找回密码、JWKS。只装配本地驱动与本组路由（见 helpers/identity-harness.ts）。
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { parsePathHeader, parseServerTiming } from '@cloudalbum/contracts';
import { totpAt } from '../../src/adapters/auth/local/totp.js';
import { makeHarness, type Harness } from '../helpers/identity-harness.js';

let h: Harness;

beforeAll(async () => {
  h = await makeHarness();
});

afterAll(async () => {
  await h?.close();
});

const PASSWORD = 'Correct-horse-42';

function cookieMap(res: request.Response): Record<string, string> {
  const raw = res.headers['set-cookie'] as unknown as string[] | undefined;
  const out: Record<string, string> = {};
  for (const line of raw ?? []) {
    const [pair, ...attrs] = line.split(';');
    const [k, v] = pair!.split('=');
    out[k!.trim()] = v ?? '';
    out[`${k!.trim()}__attrs`] = attrs.join(';');
  }
  return out;
}

async function verifyViaSelfOutbox(agent: ReturnType<typeof request.agent>, email: string): Promise<void> {
  const list = await agent.get('/api/me/outbox').expect(200);
  expect(list.body.selfPreview).toBe(true);
  expect(list.body.transport).toBe('outbox');
  const mail = list.body.items.find((m: { category: string }) => m.category === 'verification');
  expect(mail).toBeTruthy();
  const detail = await agent.get(`/api/me/outbox/${mail.id}`).expect(200);
  expect(parsePathHeader(detail.headers['x-cloudalbum-path']).modules.find((s) => s.module === 'email')?.raw).toBe('outbox:preview');
  expect(detail.body.hasBody).toBe(true);
  const link = (detail.body.links as string[]).find((l) => l.includes('/verify?'));
  expect(link).toBeTruthy();
  const code = new URL(link!).searchParams.get('code')!;
  await agent.post('/api/auth/confirm').send({ email, code }).expect(200);
}

describe('注册 → 验证 → 登录（auth=local + email=outbox）', () => {
  const email = 'alice@example.com';
  const agent = () => request.agent(h.app);
  let a: ReturnType<typeof request.agent>;

  it('注册返回 201，签发受限会话（HttpOnly + SameSite=Lax 的 ca_at / ca_rt）', async () => {
    a = agent();
    const res = await a.post('/api/auth/register').send({ email, password: PASSWORD, displayName: 'Alice' }).expect(201);
    expect(res.body).toMatchObject({ needsConfirmation: true, restrictedSession: true, verification: { transport: 'outbox', selfPreview: true } });
    expect(res.body.user).toMatchObject({ email, emailVerified: false, restricted: true, provider: 'local', role: 'member' });
    const cookies = cookieMap(res);
    expect(cookies.ca_at).toBeTruthy();
    expect(cookies.ca_at__attrs).toMatch(/HttpOnly/i);
    expect(cookies.ca_at__attrs).toMatch(/SameSite=Lax/i);
    expect(cookies.ca_at__attrs).not.toMatch(/Secure/i);            // APP_BASE_URL 是 http
    expect(cookies.ca_rt__attrs).toMatch(/Path=\/api\/auth/);
    expect(parsePathHeader(res.headers['x-cloudalbum-path']).modules.map((s) => s.module)).toContain('auth');
  });

  it('受限会话只能访问 /api/auth/*、/api/me/outbox*：其余 /api/* 返回 403 EMAIL_NOT_VERIFIED', async () => {
    const r = await a.get('/api/albums').expect(403);
    expect(r.body.error).toBe('EMAIL_NOT_VERIFIED');
    const s = await a.get('/api/auth/session').expect(200);
    expect(s.body).toMatchObject({ authenticated: true, user: { email, restricted: true } });
  });

  it('同一邮箱再次注册返回 409', async () => {
    const r = await request(h.app).post('/api/auth/register').send({ email: 'ALICE@example.com', password: PASSWORD }).expect(409);
    expect(r.body.error).toBe('EMAIL_TAKEN');
  });

  it('弱密码返回 400 WEAK_PASSWORD 并列出违反项', async () => {
    const r = await request(h.app).post('/api/auth/register').send({ email: 'weak@example.com', password: 'password1' }).expect(400);
    expect(r.body.error).toBe('WEAK_PASSWORD');
    expect(r.body.details.violations.length).toBeGreaterThan(0);
  });

  it('/me/outbox 中出现验证邮件，点验证链接后会话不再受限，默认相册已建好（F2）', async () => {
    await verifyViaSelfOutbox(a, email);
    const albums = await a.get('/api/albums').expect(200);
    expect(albums.body.items).toHaveLength(1);
    expect(albums.body.items[0]).toMatchObject({ isDefault: true, photoCount: 0, title: '默认相册' });
  });

  it('验证码只能用一次', async () => {
    const list = await a.get('/api/me/outbox').expect(200);
    const detail = await a.get(`/api/me/outbox/${list.body.items[0].id}`).expect(200);
    const code = new URL((detail.body.links as string[])[0]!).searchParams.get('code');
    const r = await a.post('/api/auth/confirm').send({ email, code }).expect(400);
    expect(r.body.error).toBe('INVALID_CODE');
  });

  it('登录：401（错误密码，统一提示）→ 200；响应只有 Cookie，没有令牌', async () => {
    const bad = await request(h.app).post('/api/auth/login').send({ email, password: 'wrong-password-1' }).expect(401);
    expect(bad.body.error).toBe('INVALID_CREDENTIALS');
    const nobody = await request(h.app).post('/api/auth/login').send({ email: 'nobody@example.com', password: 'wrong-password-1' }).expect(401);
    expect(nobody.body).toEqual(bad.body);
    const ok = await agent().post('/api/auth/login').send({ email, password: PASSWORD }).expect(200);
    expect(ok.body).toMatchObject({ kind: 'tokens', user: { email, emailVerified: true, restricted: false } });
    expect(JSON.stringify(ok.body)).not.toMatch(/eyJ/);               // JWT 不出现在响应体中
  });

  it('已认证请求带 auth=local:verify 路径段与 auth 的 Server-Timing', async () => {
    const r = await a.get('/api/albums').expect(200);
    expect(parsePathHeader(r.headers['x-cloudalbum-path']).modules.find((s) => s.module === 'auth')?.raw).toBe('local:verify');
    expect(parseServerTiming(r.headers['server-timing']).some((m) => m.name === 'auth')).toBe(true);
  });

  it('刷新令牌轮换；旧令牌被重放时整族作废', async () => {
    const b = agent();
    const login = await b.post('/api/auth/login').send({ email, password: PASSWORD }).expect(200);
    const oldRt = cookieMap(login).ca_rt!;
    const r1 = await b.post('/api/auth/refresh').expect(200);
    expect(cookieMap(r1).ca_rt).not.toBe(oldRt);
    // 重放旧刷新令牌 → 401 REFRESH_TOKEN_REUSED，并且新令牌也一起失效
    const replay = await request(h.app).post('/api/auth/refresh').set('Cookie', `ca_rt=${oldRt}`).expect(401);
    expect(replay.body.error).toBe('REFRESH_TOKEN_REUSED');
    const after = await b.post('/api/auth/refresh').expect(401);
    expect(after.body.error).toBe('INVALID_REFRESH_TOKEN');
  });

  it('登出后旧 access token 立即失效（tv 声明与 users.token_version 比对）', async () => {
    const b = agent();
    const login = await b.post('/api/auth/login').send({ email, password: PASSWORD }).expect(200);
    const at = cookieMap(login).ca_at!;
    await request(h.app).get('/api/albums').set('Authorization', `Bearer ${at}`).expect(200);
    await b.post('/api/auth/logout').expect(204);
    const r = await request(h.app).get('/api/notifications').set('Authorization', `Bearer ${at}`).expect(401);
    expect(r.body.reason).toBe('TOKEN_REVOKED');
  });

  it('GET /api/auth/session?for=social 返回内存中的短期令牌', async () => {
    const b = agent();
    await b.post('/api/auth/login').send({ email, password: PASSWORD }).expect(200);
    const s = await b.get('/api/auth/session?for=social').expect(200);
    expect(s.body.token).toMatch(/^eyJ/);
    expect(Date.parse(s.body.expiresAt)).toBeGreaterThan(Date.now());
    const anon = await request(h.app).get('/api/auth/session').expect(200);
    expect(anon.body.authenticated).toBe(false);
  });
});

describe('防护：CSRF、锁定、防枚举', () => {
  it('以 Cookie 认证的跨站写请求返回 403；Bearer 令牌不受 Origin 检查', async () => {
    const a = request.agent(h.app);
    await a.post('/api/auth/register').send({ email: 'csrf@example.com', password: PASSWORD }).expect(201);
    await a.post('/api/auth/resend').send({}).set('Origin', 'https://evil.example').expect(403);
    await a.post('/api/auth/resend').send({}).set('Origin', 'http://localhost:3000').expect(204);
    await a.post('/api/auth/resend').send({}).set('Sec-Fetch-Site', 'cross-site').expect(403);
  });

  it('连续输错密码达到阈值后返回 423 ACCOUNT_LOCKED（带 Retry-After），锁定期间正确密码也被拒绝', async () => {
    const email = 'locked@example.com';
    await request(h.app).post('/api/auth/register').send({ email, password: PASSWORD }).expect(201);
    const codes: number[] = [];
    for (let i = 0; i < 5; i += 1) codes.push((await request(h.app).post('/api/auth/login').send({ email, password: `nope-${i}-xyz1` })).status);
    expect(codes.slice(0, 4)).toEqual([401, 401, 401, 401]);
    expect(codes[4]).toBe(423);
    const r = await request(h.app).post('/api/auth/login').send({ email, password: PASSWORD }).expect(423);
    expect(r.headers['retry-after']).toBeTruthy();
    const audit = await h.c.db('audit_log').where({ action: 'user.login_failed' }).count({ n: '*' }).first();
    expect(Number(audit?.n)).toBeGreaterThanOrEqual(6);
  });

  it('找回密码对不存在的邮箱同样返回 202', async () => {
    await request(h.app).post('/api/auth/forgot').send({ email: 'ghost@example.com' }).expect(202);
  });
});

describe('找回密码与 MFA', () => {
  const email = 'bob@example.com';

  it('forgot → 管理员可见的重置邮件（本人预览不显示 password-reset）→ reset → 旧会话失效、新密码可登录', async () => {
    const a = request.agent(h.app);
    await a.post('/api/auth/register').send({ email, password: PASSWORD, displayName: 'Bob' }).expect(201);
    await verifyViaSelfOutbox(a, email);
    await request(h.app).post('/api/auth/forgot').send({ email }).expect(202);
    const own = await a.get('/api/me/outbox').expect(200);
    expect(own.body.items.some((m: { category: string }) => m.category === 'password-reset')).toBe(false);
    const row = await h.c.db('outbox_emails').where({ category: 'password-reset' }).orderBy('created_at', 'desc').first();
    const body = h.adapters.email.readBody(row);
    const code = new URL(body!.text!.match(/https?:\/\/\S+/)![0]).searchParams.get('code')!;
    await request(h.app).post('/api/auth/reset').send({ email, code, newPassword: 'weak' }).expect(400);
    await request(h.app).post('/api/auth/reset').send({ email, code, newPassword: 'Another-pass-77' }).expect(200);
    await a.get('/api/albums').expect(401);                       // token_version 已变
    await request(h.app).post('/api/auth/login').send({ email, password: PASSWORD }).expect(401);
    await request(h.app).post('/api/auth/login').send({ email, password: 'Another-pass-77' }).expect(200);
  });

  it('MFA：enroll → 确认 → 登录需要挑战 → 用 TOTP 完成登录；密钥经 CryptoPort 加密存储', async () => {
    const a = request.agent(h.app);
    await a.post('/api/auth/login').send({ email, password: 'Another-pass-77' }).expect(200);
    const enroll = await a.post('/api/auth/mfa/enroll').expect(200);
    expect(enroll.body.otpauthUrl).toMatch(/^otpauth:\/\/totp\//);
    expect(enroll.body.qrDataUrl).toMatch(/^data:image\/png;base64,/);
    const secret = enroll.body.secret as string;
    const row = await h.c.db('users').where({ email }).first();
    expect(row.mfa_secret_enc).toMatch(/^ca1\./);
    expect(row.mfa_secret_enc).not.toContain(secret);
    await a.post('/api/auth/mfa/verify').send({ code: '000000' }).expect(400);
    await a.post('/api/auth/mfa/verify').send({ code: totpAt(secret) }).expect(200);

    const login = await request(h.app).post('/api/auth/login').send({ email, password: 'Another-pass-77' }).expect(200);
    expect(login.body.kind).toBe('mfa_required');
    expect(login.headers['set-cookie']).toBeUndefined();
    const bad = await request(h.app).post('/api/auth/mfa/verify').send({ challengeId: login.body.challengeId, code: '123456' });
    expect(bad.status).toBe(401);
    const ok = await request(h.app).post('/api/auth/mfa/verify').send({ challengeId: login.body.challengeId, code: totpAt(secret) }).expect(200);
    expect(ok.body).toMatchObject({ kind: 'tokens', user: { email, mfaEnabled: true } });
    await request(h.app).post('/api/auth/mfa/verify').send({ challengeId: login.body.challengeId, code: totpAt(secret) }).expect(401);
  });
});

describe('JWKS 与能力', () => {
  it('jwks() 发布 ES256 公钥（kty=EC、crv=P-256、alg=ES256），不含私钥参数', () => {
    const jwks = h.c.auth.jwks()!;
    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0]).toMatchObject({ kty: 'EC', crv: 'P-256', alg: 'ES256', use: 'sig' });
    expect(jwks.keys[0]!.d).toBeUndefined();
    expect(jwks.keys[0]!.kid).toBeTruthy();
  });

  it('L0：本组负责的模块全部 off 且 localHealth=ok；/api/health/ready 200；路径头带 config=file:vN', async () => {
    await h.c.capabilities.probeAll({ timeoutMs: 5000 });
    const res = await request(h.app).get('/api/capabilities').expect(200);
    for (const m of ['auth', 'secrets', 'kms', 'config', 'email', 'notification', 'logging', 'monitoring', 'tracing'] as const) {
      expect(res.body.modules[m].status, m).toBe('off');
      expect(res.body.modules[m].localHealth, `${m}: ${res.body.modules[m].detail}`).toBe('ok');
    }
    expect(parsePathHeader(res.headers['x-cloudalbum-path']).modules.find((s) => s.module === 'config')?.raw).toMatch(/^file:v\d+$/);
    await request(h.app).get('/api/health/ready').expect(200);
  });
});
