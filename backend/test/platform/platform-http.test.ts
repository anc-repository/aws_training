// ATL 平台模式的 HTTP 行为（06 PM-03、PM-09～PM-11、PM-20、PM-40）：平台模式开启的 L0 容器 + supertest（经 127.0.0.1 = 回环）
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Express } from 'express';
import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildContainer, type Container } from '../../src/container.js';
import { createApp } from '../../src/http/app.js';
import { frameAncestors } from '../../src/http/middleware/frame-ancestors.js';
import { platformMode, setPlatformStateForTests } from '../../src/platform/mode.js';
import { generateLocalSecret, issueProbeToken } from '../../src/platform/probe-token.js';
import type { Principal } from '../../src/ports/auth.js';
import { insertLabRun } from '../../src/repositories/lab.js';
import { l0EnvDir } from '../helpers/identity-harness.js';
import { seedUser } from '../helpers/media-fixtures.js';

const PLATFORM_ENV = [
  'ATL_PLATFORM_MODE=on', 'ATL_SESSION_ID=s4k7m2q9x1abc', 'ATL_ENV_ID=01jc9x3k9cq4m2x8n5b6c0d1e2', 'ATL_ENV_NAME=etest001',
  'ATL_LAB_ID=svc-cdn', 'ATL_PLATFORM_ORIGIN=https://atl.example.test',
].join('\n');

let c: Container;
let app: Express;
let secret: string;
let adminId: string;

beforeAll(async () => {
  const { envDir } = l0EnvDir({ base: { CLOUDALBUM_ENV: 'etest001', STORAGE_LOCAL_MIN_FREE_PCT: '1' } });
  secret = generateLocalSecret();
  writeFileSync(path.join(envDir, 'platform.env'), `${PLATFORM_ENV}\n`);
  mkdirSync(path.join(envDir, 'atl'), { recursive: true });
  writeFileSync(path.join(envDir, 'atl', 'probe.token'), `${secret}\n`);
  writeFileSync(path.join(envDir, 'local.override.env'), 'STORAGE_LOCAL_MIN_FREE_PCT=1\n');
  c = await buildContainer('api', { envDir, processEnv: { NODE_ENV: 'test' } });
  Object.defineProperty(c.auth, 'verifyAccessToken', {
    configurable: true, writable: true,
    value: async (token: string): Promise<Principal> => ({
      provider: 'local', subject: token, email: `${token}@example.com`, emailVerified: true, groups: ['admin'], plan: 'free', expiresAt: Date.now() / 1000 + 3600,
    }),
  });
  adminId = await seedUser(c.db, { role: 'admin' });
  app = createApp(c);
});

afterAll(async () => {
  await c?.close();
  setPlatformStateForTests(null);
});

const local = () => ({ 'X-ATL-Probe-Token': secret });

describe('平台模式：探测主体与 /api/lab/probe/*（PM-09～PM-11）', () => {
  it('平台模式由 platform.env 打开（唯一判定处 platformMode()）', () => {
    expect(platformMode()).toBe(true);
  });

  it('本机令牌 + 回环：now / echo / media-url 返回 200，带路径头与 no-store', async () => {
    const now = await request(app).get('/api/lab/probe/now').set(local()).expect(200);
    expect(now.headers['cache-control']).toBe('private, no-store');
    expect(now.headers['x-cloudalbum-path']).toMatch(/database=sqlite/);
    expect(Date.parse(now.body.now)).toBeGreaterThan(0);
    expect(now.body.nonce).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(now.body.db).toEqual({ driver: 'sqlite', hostClass: 'file' });
    const again = await request(app).get('/api/lab/probe/now').set(local()).expect(200);
    expect(again.headers['x-cloudalbum-path']).toMatch(/database=sqlite/);       // 数据库调用不在 cache-aside 的 loader 里
    const echo = await request(app).get('/api/lab/probe/echo').set(local()).set('Cookie', 'ca_at=secret-cookie').expect(200);
    expect(echo.body.hasCookie).toBe(true);
    expect(JSON.stringify(echo.body)).not.toContain('secret-cookie');
    expect(JSON.stringify(echo.body)).not.toContain(secret);
    expect(echo.body.headerNames).toContain('x-atl-probe-token');
    const media = await request(app).get('/api/lab/probe/media-url?variant=original&visibility=private').set(local()).expect(200);
    expect(media.body).toMatchObject({ provider: 'storage:local', signed: true });
    expect(media.body.url).toMatch(/_probe\//);
  });

  it('不带令牌 401；未知端点 404 PROBE_UNKNOWN；非 GET 405', async () => {
    const r = await request(app).get('/api/lab/probe/now').expect(401);
    expect(r.body.error.code).toBe('PROBE_TOKEN_MISSING');
    const u = await request(app).get('/api/lab/probe/nope').set(local()).expect(404);
    expect(u.body.error.code).toBe('PROBE_UNKNOWN');
    await request(app).post('/api/lab/probe/now').set(local()).expect(405);
  });

  it('本机令牌经 8080（cdn）或 ALB 入口 → 401 PROBE_LOCAL_ONLY；伪造的令牌 → PROBE_TOKEN_INVALID', async () => {
    const viaCdn = await request(app).get('/api/lab/probe/now').set(local()).set('X-CloudAlbum-Entry', 'cloudfront>nginx').expect(401);
    expect(viaCdn.body.error.code).toBe('PROBE_LOCAL_ONLY');
    const viaAlb = await request(app).get('/api/lab/probe/now').set(local()).set('X-CloudAlbum-Entry', 'alb>nginx').expect(401);
    expect(viaAlb.body.error.code).toBe('PROBE_LOCAL_ONLY');
    const forged = await request(app).get('/api/lab/probe/now').set('X-ATL-Probe-Token', generateLocalSecret()).expect(401);
    expect(forged.body.error.code).toBe('PROBE_TOKEN_INVALID');
  });

  it('一次性令牌：来源不限；第一次 200，重放 401 PROBE_TOKEN_REPLAYED；过期 401 PROBE_TOKEN_EXPIRED', async () => {
    const { token } = issueProbeToken(secret, 30);
    await request(app).get('/api/lab/probe/now').set('X-ATL-Probe-Token', token).set('X-CloudAlbum-Entry', 'cloudfront>nginx').expect(200);
    const replay = await request(app).get('/api/lab/probe/now').set('X-ATL-Probe-Token', token).expect(401);
    expect(replay.body.error.code).toBe('PROBE_TOKEN_REPLAYED');
    const old = issueProbeToken(secret, 10, Math.floor(Date.now() / 1000) - 60).token;
    const expired = await request(app).get('/api/lab/probe/now').set('X-ATL-Probe-Token', old).expect(401);
    expect(expired.body.error.code).toBe('PROBE_TOKEN_EXPIRED');
  });

  it('探测请求不计入 LabMetricsStore（PM-10）；X-ATL-Probe-Nonce 只做标记、不授予权限', async () => {
    const before = c.labMetrics.recent(5000).length;
    await request(app).get('/api/lab/probe/echo').set(local()).expect(200);
    await request(app).get('/api/health/live').set('X-ATL-Probe-Nonce', 'abcdefghijklmnop1234').expect(200);
    expect(c.labMetrics.recent(5000).length).toBe(before);
    await request(app).get('/api/lab/probe/now').set('X-ATL-Probe-Nonce', 'abcdefghijklmnop1234').expect(401);
    await request(app).get('/api/health/live').expect(200);
    expect(c.labMetrics.recent(5000).length).toBe(before + 1);
    const metrics = await request(app).get('/metrics').expect(200);
    expect(metrics.text).toMatch(/cloudalbum_atl_probe_requests_total\{role="api",kind="nonce"\} [1-9]/);
  });
});

describe('平台模式：capabilities（PM-03、PM-10）', () => {
  it('公开视图只有 app.platform.mode；探测主体 view=admin 看到完整字段与 https.hostKind', async () => {
    const pub = await request(app).get('/api/capabilities').expect(200);
    expect(pub.body.app.platform).toEqual({ mode: 'on' });
    expect(pub.body.view).toBe('public');
    const adm = await request(app).get('/api/capabilities?view=admin').set(local()).expect(200);
    expect(adm.body.view).toBe('admin');
    expect(adm.body.app.platform).toMatchObject({ mode: 'on', sessionId: 's4k7m2q9x1abc', labId: 'svc-cdn', variant: 'default', probe: { localToken: 'present' } });
    expect(adm.body.https.hostKind).toBe('dns');
    expect(adm.body.modules.ec2.localHealth).toBeDefined();
    expect(adm.headers['x-cloudalbum-path']).toBeDefined();
  });

  it('atl-probe 带 deep=1 → 403 PROBE_DEEP_FORBIDDEN；无效令牌请求 view=admin → 401', async () => {
    const r = await request(app).get('/api/capabilities?view=admin&deep=1').set(local()).expect(403);
    expect(r.body.error.code).toBe('PROBE_DEEP_FORBIDDEN');
    const bad = await request(app).get('/api/capabilities?view=admin').set('X-ATL-Probe-Token', 'atlpk1.bad').expect(401);
    expect(bad.body.error.code).toBe('PROBE_TOKEN_INVALID');
  });

  it('?fields= 投影（01 §9.3 的最小集合）与 ?modules=；非法路径 400 FIELDS_INVALID；未知模块 400 MODULE_UNKNOWN', async () => {
    const fields = [
      'app.profile', 'app.entry', 'app.configHash', 'app.instance', 'app.platform', 'https',
      'validation.errors[].rule', 'validation.errors[].modules', 'validation.warnings[].rule', 'validation.warnings[].modules',
      'modules.*.driver', 'modules.*.status', 'modules.*.localHealth', 'modules.*.confidence', 'modules.*.detail', 'features.*.enabled',
    ].join(',');
    const r = await request(app).get(`/api/capabilities?fields=${encodeURIComponent(fields)}&modules=cdn,iam&view=admin`).set(local()).expect(200);
    expect(Object.keys(r.body.modules).sort()).toEqual(['cdn', 'iam']);
    expect(Object.keys(r.body.modules.cdn).sort()).toEqual(['confidence', 'detail', 'driver', 'localHealth', 'status']);
    expect(r.body.app.platform.sessionId).toBe('s4k7m2q9x1abc');
    expect(r.body.lab).toBeUndefined();
    expect(Object.values(r.body.features as Record<string, unknown>).every((f) => Object.keys(f as object).join() === 'enabled')).toBe(true);
    const bad = await request(app).get('/api/capabilities?fields=app.secret').expect(400);
    expect(bad.body.error.code).toBe('FIELDS_INVALID');
    const star = await request(app).get('/api/capabilities?fields=app.*').expect(400);
    expect(star.body.error.code).toBe('FIELDS_INVALID');
    const unk = await request(app).get('/api/capabilities?modules=nope').expect(400);
    expect(unk.body.error.code).toBe('MODULE_UNKNOWN');
  });
});

describe('平台模式：运行归属（PM-40）', () => {
  it('匿名请求带已登记、时间窗内、标签一致的 runId 被归属；未登记 / 标签不符被忽略（不是 403）', async () => {
    const runId = '01JB3M2C8Y3T5Q6W7E8R9T0Y1V';
    await insertLabRun(c.db, { runId, module: 'cdn', experiment: 'media-load', label: 'after', windowSec: 600 });
    await request(app).get('/api/health/live').set('X-Experiment-Run', runId).set('X-Experiment-Label', 'after').expect(200);
    expect(c.labMetrics.recent(1)[0]).toMatchObject({ runId, label: 'after' });
    await request(app).get('/api/health/live').set('X-Experiment-Run', runId).set('X-Experiment-Label', 'before').expect(200);
    expect(c.labMetrics.recent(1)[0]?.runId).toBeUndefined();
    await request(app).get('/api/health/live').set('X-Experiment-Run', '01JB3M2C8Y3T5Q6W7E8R9T0Y1W').set('X-Experiment-Label', 'after').expect(200);
    expect(c.labMetrics.recent(1)[0]?.runId).toBeUndefined();
    // X-Compare-Bypass 仍然只对管理员有效
    await request(app).get('/api/feed').set('X-Compare-Bypass', 'cache').expect(403);
  });

  it('POST /api/lab/runs 接受 variant 与 windowSec（PM-37、PM-38）', async () => {
    const r = await request(app).post('/api/lab/runs').set({ Authorization: `Bearer ${adminId}` })
      .send({ module: 'queue', experiment: 'upload-burst', label: 'l0', variant: { label: 'l0', role: 'baseline', cardVariant: 'default' }, windowSec: 900 })
      .expect(201);
    const row = await request(app).get(`/api/lab/runs/${r.body.runId}`).set({ Authorization: `Bearer ${adminId}` }).expect(200);
    expect(row.body.variant).toEqual({ label: 'l0', role: 'baseline', cardVariant: 'default' });
    expect(Number(row.body.window_sec)).toBe(900);
  });
});

describe('实验主体 atl-lab（PM-17）', () => {
  it('Authorization: CA-Lab 在平台模式下等同于最早的管理员：可以登记运行；凭证类操作 403；无效令牌 401', async () => {
    const { issueLabToken } = await import('../../src/platform/probe-token.js');
    const { token } = issueLabToken(secret, 600);
    const lab = { Authorization: `CA-Lab ${token}` };
    const r = await request(app).post('/api/lab/runs').set(lab).send({ module: 'cdn', experiment: 'media-load', label: 'after' }).expect(201);
    expect(r.body.runId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    await request(app).get('/api/lab/runs').set(lab).expect(200);
    const scope = await request(app).post('/api/auth/mfa/enroll').set(lab).expect(403);
    expect(scope.body.error.code).toBe('LAB_TOKEN_SCOPE');
    const bad = await request(app).get('/api/lab/runs').set({ Authorization: `CA-Lab ${token.slice(0, -2)}xx` }).expect(401);
    expect(bad.body.error.code).toBe('LAB_TOKEN_INVALID');
  });
});

describe('HTML 响应的 CSP frame-ancestors（PM-20，应用侧）', () => {
  it('平台模式：text/html 带 frame-ancestors，JSON 不带；任何模式都没有 X-Frame-Options', async () => {
    const mini = express();
    mini.use(frameAncestors());
    mini.get('/page', (_req, res) => { res.set('X-Frame-Options', 'DENY'); res.type('html').send('<p>ok</p>'); });
    mini.get('/json', (_req, res) => { res.json({ ok: true }); });
    const page = await request(mini).get('/page').expect(200);
    expect(page.headers['content-security-policy']).toBe("frame-ancestors 'self' https://atl.example.test");
    expect(page.headers['x-frame-options']).toBeUndefined();
    const json = await request(mini).get('/json').expect(200);
    expect(json.headers['content-security-policy']).toBeUndefined();
  });
});
