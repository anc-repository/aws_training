// wave1-integration：第 1 波模块的侧路端点经 http/app.ts 的 ROUTE_MODULES 挂载（不再由各测试自己挂在 createApp 之前），
// 以及 notification / email 的功能对照端点与 cost 的 local 档探针（L0 容器，不调用 AWS）。
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { buildContainer, type Container } from '../../src/container.js';
import { createApp, ROUTE_MODULES } from '../../src/http/app.js';
import * as adminRoutes from '../../src/http/routes/admin.js';
import * as labRoutes from '../../src/http/routes/lab.js';
import * as wafLabRoutes from '../../src/adapters/waf/lab-routes.js';
import type { Principal } from '../../src/ports/auth.js';
import { tempEnvDir } from '../helpers/config.js';
import { l0Secrets } from '../helpers/identity-harness.js';
import { seedUser } from '../helpers/media-fixtures.js';

let c: Container;
let app: Express;
let adminId: string;
let memberId: string;

beforeAll(async () => {
  const data = mkdtempSync(path.join(os.tmpdir(), 'cloudalbum-wave1-routes-'));
  const envDir = tempEnvDir({ base: { APP_BASE_URL: 'http://localhost:3000', CLOUDALBUM_DATA_DIR: data.replace(/\\/g, '/') }, secrets: l0Secrets() });
  c = await buildContainer('api', { envDir, processEnv: { NODE_ENV: 'test' } });
  Object.defineProperty(c.auth, 'verifyAccessToken', {
    configurable: true, writable: true,
    value: async (token: string): Promise<Principal> => ({
      provider: 'local', subject: token, email: `${token}@example.com`, emailVerified: true,
      groups: token === memberId ? [] : ['admin'], plan: 'free', expiresAt: Date.now() / 1000 + 3600,
    }),
  });
  adminId = await seedUser(c.db, { role: 'admin' });
  memberId = await seedUser(c.db, { role: 'member' });
  app = createApp(c);
});

afterAll(async () => {
  await c?.close();
});

const admin = () => ({ Authorization: `Bearer ${adminId}` });
const member = () => ({ Authorization: `Bearer ${memberId}` });

describe('ROUTE_MODULES', () => {
  it('第 1 波的路由文件先于 admin.ts（/api/admin/* 兜底）与 lab.ts（/api/lab/* 501 兜底）', () => {
    const list = ROUTE_MODULES as readonly unknown[];
    expect(list.indexOf(wafLabRoutes)).toBeGreaterThan(-1);
    expect(list.indexOf(wafLabRoutes)).toBeLessThan(list.indexOf(adminRoutes));
    expect(list.indexOf(adminRoutes)).toBeLessThan(list.indexOf(labRoutes));
  });

  it.each([
    ['/api/lab/monitoring/alarms'],
    ['/api/lab/cost'],
    ['/api/lab/logs?requestId=01JABCDEFGHJKMNPQRSTVWXYZ0'],
    ['/api/lab/waf/origin?run=01JABCDEFGHJKMNPQRSTVWXYZ0'],
    ['/api/admin/security/blocklist'],
    ['/api/lab/identity-pool/whoami'],
  ])('GET %s：管理员 200（不再是 404 / 501），普通用户 403', async (url) => {
    const r = await request(app).get(url).set(admin());
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    await request(app).get(url).set(member()).expect(403);
  });
});

describe('功能对照端点（lab-modules.ts）', () => {
  it('POST /api/lab/notification/compare：L0 只跑 db 一侧，sns 一侧说明未启用', async () => {
    await request(app).post('/api/lab/notification/compare').set(member()).expect(403);
    const r = await request(app).post('/api/lab/notification/compare').set(admin()).expect(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.body).toMatchObject({ type: 'report.ready', audience: 'admin', recipients: 1 });
    expect(r.body.db).toMatchObject({ emailTransport: 'outbox' });
    expect(r.body.db.error).toBeUndefined();
    expect(r.body.sns.skipped).toContain('NOTIFY_DRIVER=db');
  });

  it('POST /api/lab/email/compare：校验收件人；L0 只写 outbox，ses 一侧说明未启用', async () => {
    await request(app).post('/api/lab/email/compare').set(admin()).send({}).expect(400);
    await request(app).post('/api/lab/email/compare').set(admin()).send({ to: 'not-an-address' }).expect(400);
    const r = await request(app).post('/api/lab/email/compare').set(admin()).send({ to: 'ops@mail.test-only.dev' }).expect(200);
    expect(r.body).toMatchObject({ to: 'ops@mail.test-only.dev', reserved: false });
    expect(r.body.outbox).toMatchObject({ transport: 'outbox' });
    expect(r.body.ses.skipped).toContain('EMAIL_DRIVER=outbox');
  });
});

describe('cost 的 local 档探针（container.ts 登记）', () => {
  it('COST_MODE=local 时 capabilities 也有本地估算的 detail（不显示金额）', async () => {
    await c.capabilities.probeModule('cost');
    const r = await request(app).get('/api/capabilities').set(admin()).expect(200);
    const cost = r.body.modules.cost as { status: string; localHealth?: string; detail?: string };
    expect(cost.status).toBe('off');
    expect(cost.localHealth).toBe('ok');
    expect(cost.detail).toContain('不显示金额');
  });
});
