// logging 的 /lab 侧路端点（adapters/logging/lab-routes.ts）：L0 容器 + 与 createApp 相同的前置中间件。该路由模块已加入
// http/app.ts 的 ROUTE_MODULES（wave1-integration）；测试里仍把它显式挂在 createApp 之前（cloudwatch 一侧换一个容器视图）。cloudwatch 一侧用内存 CloudWatch Logs。
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import cookieParser from 'cookie-parser';
import express, { type ErrorRequestHandler, type Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { lazyAwsClients } from '../../src/adapters/aws/clients.js';
import * as logRoutes from '../../src/adapters/logging/lab-routes.js';
import { buildContainer, type Container } from '../../src/container.js';
import type { HttpError } from '../../src/errors.js';
import { createApp } from '../../src/http/app.js';
import { authenticate } from '../../src/http/middleware/auth.js';
import { requestContext } from '../../src/http/middleware/request-context.js';
import type { Principal } from '../../src/ports/auth.js';
import { FakeCwLogs } from '../adapters/aws/fake-cwlogs.js';
import { fakeCredentials, testConfig } from '../adapters/aws/helpers.js';
import { ENABLE, tempEnvDir } from '../helpers/config.js';
import { l0Secrets } from '../helpers/identity-harness.js';
import { seedUser } from '../helpers/media-fixtures.js';

let c: Container;
let app: Express;
let cwApp: Express;
let fake: FakeCwLogs;
let adminId: string;
let memberId: string;
const RUN = '01JABCDEFGHJKMNPQRSTVWXYZ0';

function wrap(cc: Container): Express {
  const a = express();
  a.use(express.json());
  a.use(cookieParser());
  a.use(requestContext());
  a.use(authenticate(cc));
  logRoutes.register(a, cc);
  a.use(createApp(c));
  a.use(((err, _req, res, _next) => {
    const e = err as HttpError;
    res.status(e.status ?? 500).json({ error: e.code ?? 'INTERNAL', message: e.message });
  }) as ErrorRequestHandler);
  return a;
}

beforeAll(async () => {
  const data = mkdtempSync(path.join(os.tmpdir(), 'cloudalbum-lablogs-'));
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
  const logDir = c.config.logging.LOG_DIR;
  mkdirSync(logDir, { recursive: true });
  const now = Date.now();
  const nginx = (rid: string, status: number, ms: number) => JSON.stringify({ ts: new Date(now - ms).toISOString(), rid, method: 'GET', uri: '/api/lab/now', status, run: RUN });
  writeFileSync(path.join(logDir, 'nginx-access.json'), `${[nginx('r1', 200, 3000), nginx('r2', 503, 2000), nginx('r3', 503, 1000)].join('\n')}\n`);
  app = wrap(c);

  fake = new FakeCwLogs();
  fake.createGroup('/cloudalbum/lab/app', 14);
  fake.createGroup('/cloudalbum/lab/nginx', 14);
  fake.groups.get('/cloudalbum/lab/nginx')!.streams.set('i-1/access', [
    { timestamp: now - 2000, message: nginx('r2', 503, 2000), ingestionTime: now - 1500, logStreamName: 'i-1/access' },
    { timestamp: now - 1000, message: nginx('r3', 503, 1000), ingestionTime: now - 400, logStreamName: 'i-1/access' },
  ]);
  const { cfg } = testConfig({ ...ENABLE.iamRole, ...ENABLE.logging });
  cwApp = wrap({ ...c, config: { ...c.config, logging: cfg.logging }, aws: lazyAwsClients({ region: 'ap-northeast-1', credentials: fakeCredentials }) });
});

afterAll(async () => {
  await c?.close();
  fake?.restore();
});

const admin = () => ({ Authorization: `Bearer ${adminId}` });

describe('/api/lab/logs（L0：LOG_DRIVER=file）', () => {
  it('只对管理员开放；本地扫描按 run 关键字与级别过滤，返回 meta（local-scan、扫描字节、用时）', async () => {
    await request(app).get('/api/lab/logs').expect(401);
    await request(app).get('/api/lab/logs').set({ Authorization: `Bearer ${memberId}` }).expect(403);
    const r = await request(app).get(`/api/lab/logs?source=nginx&level=error&q=${RUN}`).set(admin()).expect(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.body).toMatchObject({ store: 'local', mode: 'sync', meta: { engine: 'local-scan', truncated: false } });
    expect(r.body.rows.map((x: { requestId: string }) => x.requestId)).toEqual(['r2', 'r3']);
    expect(r.body.meta.scannedBytes).toBeGreaterThan(0);
  });

  it('cloudwatch 一侧 409；本地不接受 Insights 语句；参数校验', async () => {
    expect((await request(app).get('/api/lab/logs?store=cloudwatch').set(admin()).expect(409)).body.error).toBe('LOGGING_CLOUDWATCH_OFF');
    await request(app).get('/api/lab/logs?q=stats%20count(*)').set(admin()).expect(400);
    await request(app).get('/api/lab/logs?source=kernel').set(admin()).expect(400);
    await request(app).get('/api/lab/logs?limit=0').set(admin()).expect(400);
    await request(app).get('/api/lab/logs?requestId=a%20b').set(admin()).expect(400);
  });
});

describe('/api/lab/logs（LOG_DRIVER=cloudwatch，内存 CloudWatch Logs）', () => {
  it('requestId 精确查找：行带 eventTs / ingestedAt（摄取延迟的服务端证据）', async () => {
    const r = await request(cwApp).get('/api/lab/logs?store=cloudwatch&requestId=r3').set(admin()).expect(200);
    expect(r.body.meta).toMatchObject({ engine: 'filter-log-events', instances: ['i-1'] });
    const row = r.body.rows[0];
    expect(Date.parse(row.ingestedAt) - Date.parse(row.eventTs)).toBe(600);
  });

  it('Logs Insights：异步 queryId → results 返回扫描字节', async () => {
    const q = encodeURIComponent(`filter run = "${RUN}" and status >= 500 | stats count(*) as errors by uri`);
    const s = await request(cwApp).get(`/api/lab/logs?store=cloudwatch&source=nginx&q=${q}`).set(admin()).expect(200);
    expect(s.body.mode).toBe('async');
    const res = await request(cwApp).get(`/api/lab/logs/results/${s.body.queryId}`).set(admin()).expect(200);
    expect(res.body).toMatchObject({ store: 'cloudwatch', done: true, meta: { engine: 'logs-insights' } });
    expect(res.body.rows).toHaveLength(2);
    expect(res.body.meta.scannedBytes).toBeGreaterThan(0);
    await request(cwApp).get('/api/lab/logs/results/bad!id').set(admin()).expect(400);
  });
});
