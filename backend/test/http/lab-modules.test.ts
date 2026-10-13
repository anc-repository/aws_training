// routes/lab-modules.ts：experiments 场景调用的模块侧路端点（L0 容器；管理员令牌按 media-flow.test.ts 的方式替换 verifyAccessToken）
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildContainer, type Container } from '../../src/container.js';
import { createApp } from '../../src/http/app.js';
import type { Principal } from '../../src/ports/auth.js';
import { tempEnvDir } from '../helpers/config.js';
import { l0Secrets } from '../helpers/identity-harness.js';
import { seedUser } from '../helpers/media-fixtures.js';

let c: Container;
let app: Express;
let adminId: string;

beforeAll(async () => {
  const data = mkdtempSync(path.join(os.tmpdir(), 'cloudalbum-labmod-'));
  // 开发机系统盘可能所剩不多：与 media-flow.test.ts 一样把 507 阈值降到最低
  const envDir = tempEnvDir({
    base: { APP_BASE_URL: 'http://localhost:3000', CLOUDALBUM_DATA_DIR: data.replace(/\\/g, '/') }, override: { STORAGE_LOCAL_MIN_FREE_PCT: '1' }, secrets: l0Secrets(),
  });
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
});

const admin = () => ({ Authorization: `Bearer ${adminId}` });

describe('模块侧路端点（/api/lab/*、/api/public/now）', () => {
  it('/api/public/now 匿名可读且可被 CDN 微缓存；/api/lab/now 只对管理员开放且不缓存', async () => {
    const pub = await request(app).get('/api/public/now').expect(200);
    expect(pub.headers['cache-control']).toBe('public, s-maxage=10, max-age=0');
    expect(Date.parse(pub.body.now)).toBeGreaterThan(0);
    await request(app).get('/api/lab/now').expect(401);
    const lab = await request(app).get('/api/lab/now').set(admin()).expect(200);
    expect(lab.headers['cache-control']).toBe('private, no-store');
  });

  it('iam：none 模式下 whoami / aws-ping 如实报告“没有凭证”', async () => {
    const who = await request(app).get('/api/lab/iam/whoami').set(admin()).expect(200);
    expect(who.body).toMatchObject({ kind: 'none', source: 'none', arn: null });
    const ping = await request(app).get('/api/lab/aws-ping').set(admin()).expect(200);
    expect(ping.body).toEqual({ sts: { ok: false, error: 'IAM_CREDENTIALS=none' }, iam: { ok: false, error: 'IAM_CREDENTIALS=none' } });
    await request(app).post('/api/lab/iam/refresh').set(admin()).expect(200);
  });

  it('database：read-after-write（没有只读副本时读库 = 主库，立即可见）', async () => {
    const r = await request(app).post('/api/lab/db/read-after-write').set(admin()).expect(200);
    expect(r.body).toEqual({ visible: true, lagMs: 0, replica: false });
  });

  it('storage：只为当前驱动签发 lab/ 命名空间的上传目标', async () => {
    const r = await request(app).post('/api/lab/storage/upload-target?driver=local').set(admin()).send({ contentType: 'image/jpeg', size: 1000 }).expect(200);
    expect(r.body.key).toMatch(/^lab\/upload-sidebyside\/.+\.bin$/);
    expect(r.body.uploadTarget.url).toContain('/api/storage/upload?');
    await request(app).post('/api/lab/storage/upload-target?driver=s3').set(admin()).send({ contentType: 'image/jpeg' }).expect(409);
  });
});
