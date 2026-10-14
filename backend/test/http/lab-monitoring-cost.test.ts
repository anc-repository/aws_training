// monitoring 与 cost 的 /lab 侧路端点（adapters/monitoring/lab-routes.ts、adapters/cost/lab-routes.ts）：
// L0 容器 + 与 createApp 相同的前置中间件；这两个路由模块已由集成阶段加入 http/app.ts 的 ROUTE_MODULES（wave1-integration），
// 测试里仍把它们显式挂在 createApp 之前（budgets 档要换一个容器视图）。budgets 档的 Cost Explorer 确认流程用 aws-sdk-client-mock。
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BudgetsClient, DescribeBudgetCommand } from '@aws-sdk/client-budgets';
import { CostExplorerClient, GetCostAndUsageCommand } from '@aws-sdk/client-cost-explorer';
import { GetTopicAttributesCommand, SNSClient } from '@aws-sdk/client-sns';
import { mockClient } from 'aws-sdk-client-mock';
import cookieParser from 'cookie-parser';
import express, { type ErrorRequestHandler, type Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { lazyAwsClients } from '../../src/adapters/aws/clients.js';
import * as costRoutes from '../../src/adapters/cost/lab-routes.js';
import * as monitoringRoutes from '../../src/adapters/monitoring/lab-routes.js';
import { buildContainer, type Container } from '../../src/container.js';
import type { HttpError } from '../../src/errors.js';
import { createApp } from '../../src/http/app.js';
import { authenticate } from '../../src/http/middleware/auth.js';
import { requestContext } from '../../src/http/middleware/request-context.js';
import { CostDetector } from '../../src/modules/detectors/cost.js';
import type { Principal } from '../../src/ports/auth.js';
import { fakeCredentials, testConfig } from '../adapters/aws/helpers.js';
import { ENABLE, tempEnvDir } from '../helpers/config.js';
import { l0Secrets } from '../helpers/identity-harness.js';
import { seedUser } from '../helpers/media-fixtures.js';

const budgets = mockClient(BudgetsClient);
const ce = mockClient(CostExplorerClient);
const sns = mockClient(SNSClient);

let c: Container;
let app: Express;
let budgetsApp: Express;
let adminId: string;
let memberId: string;

function wrap(cc: Container): Express {
  const a = express();
  a.use(express.json());
  a.use(cookieParser());
  a.use(requestContext());
  a.use(authenticate(cc));
  monitoringRoutes.register(a, cc);
  costRoutes.register(a, cc);
  a.use(createApp(c));
  // 与 createApp 的错误处理相同的 HttpError 映射（路由加入 ROUTE_MODULES 后由 createApp 自己处理）
  a.use(((err, _req, res, _next) => {
    const e = err as HttpError;
    res.status(e.status ?? 500).json({ error: e.code ?? 'INTERNAL', message: e.message });
  }) as ErrorRequestHandler);
  return a;
}

beforeAll(async () => {
  const data = mkdtempSync(path.join(os.tmpdir(), 'cloudalbum-labmon-'));
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
  app = wrap(c);

  // budgets 档：同一个容器，换成 budgets 的 cost 配置与感知器（AWS 调用全部被 mock）
  const { cfg, effective } = testConfig({ ...ENABLE.iamRole, ...ENABLE.cost, COST_TOPIC_ARN: 'arn:aws:sns:ap-northeast-1:123456789012:cloudalbum-lab-cost' });
  const det = new CostDetector({ cfg, env: effective, aws: lazyAwsClients({ region: 'ap-northeast-1', credentials: fakeCredentials }) });
  budgetsApp = wrap({ ...c, config: { ...c.config, cost: cfg.cost }, detectors: [det] });
  budgets.on(DescribeBudgetCommand).resolves({ Budget: { BudgetName: 'x', TimeUnit: 'MONTHLY', BudgetLimit: { Amount: '10', Unit: 'USD' } } });
  sns.on(GetTopicAttributesCommand).resolves({ Attributes: { SubscriptionsPending: '0', SubscriptionsConfirmed: '1' } });
  ce.on(GetCostAndUsageCommand).resolves({ ResultsByTime: [] });
});

afterAll(async () => {
  await c?.close();
  budgets.restore();
  ce.restore();
  sns.restore();
});

const admin = () => ({ Authorization: `Bearer ${adminId}` });

describe('/api/lab/monitoring（L0：METRICS_DRIVER=local）', () => {
  it('只对管理员开放；alarms 列出本地规则（送达路径：本地）与 CloudWatch 一侧的不可用原因', async () => {
    await request(app).get('/api/lab/monitoring/alarms').expect(401);
    await request(app).get('/api/lab/monitoring/alarms').set({ Authorization: `Bearer ${memberId}` }).expect(403);
    const r = await request(app).get('/api/lab/monitoring/alarms').set(admin()).expect(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.body.driver).toBe('local');
    expect(r.body.local.rulesSource).toBe('default');
    expect(r.body.local.alarms.map((a: { name: string }) => a.name)).toContain('api-heartbeat');
    expect(r.body.local.alarms.every((a: { delivery: string }) => a.delivery === 'local')).toBe(true);
    expect(r.body.cloudwatch).toMatchObject({ enabled: false, reason: 'METRICS_DRIVER=local' });
  });

  it('history 与 series：参数校验；本地一侧可读；CloudWatch 一侧 409', async () => {
    await request(app).get('/api/lab/monitoring/history?name=Bad').set(admin()).expect(400);
    const h = await request(app).get('/api/lab/monitoring/history?name=api-heartbeat&source=both').set(admin()).expect(200);
    expect(h.body).toMatchObject({ name: 'api-heartbeat', local: [], cloudwatchError: 'METRICS_DRIVER=local' });
    const s = await request(app).get('/api/lab/monitoring/series?name=route.count&stat=sum&period=60').set(admin()).expect(200);
    expect(s.body).toMatchObject({ source: 'local', name: 'route.count' });
    expect(Array.isArray(s.body.points)).toBe(true);
    const cwSide = await request(app).get('/api/lab/monitoring/series?name=CPUUtilization&source=cloudwatch&namespace=AWS/EC2').set(admin()).expect(409);
    expect(cwSide.body.error).toBe('MONITORING_CLOUDWATCH_OFF');
    await request(app).get('/api/lab/monitoring/series?name=x&namespace=AWS/RDS').set(admin()).expect(400);
  });

  it('synthetic：按概率返回 5xx（time-to-alert 的合成负载），请求照常进入 LabMetricsStore', async () => {
    const bad = await request(app).get('/api/lab/monitoring/synthetic?rate=1&status=503').set(admin()).expect(503);
    expect(bad.body.error).toBe('SYNTHETIC_ERROR');
    await request(app).get('/api/lab/monitoring/synthetic?rate=0').set(admin()).expect(200);
    await request(app).get('/api/lab/monitoring/synthetic?rate=2').set(admin()).expect(400);
    await request(app).get('/api/lab/monitoring/synthetic?status=404').set(admin()).expect(400);
  });
});

describe('/api/lab/cost', () => {
  it('L0：本地清单（EC2 实例、公网 IPv4），不显示金额；refresh 在 local 档返回 409', async () => {
    const r = await request(app).get('/api/lab/cost').set(admin()).expect(200);
    expect(r.body.mode).toBe('local');
    expect(r.body.local.detail).toContain('当前按小时计费的资源');
    expect(r.body.local.hourly.map((i: { module: string }) => i.module)).toEqual(['ec2', 'ec2']);
    expect(r.body.local.amount).toBeUndefined();
    expect(r.body.reminders).toEqual([]);
    expect(r.body.budgets).toBeUndefined();
    const ref = await request(app).post('/api/lab/cost/refresh').set(admin()).send({ confirm: 'ce-charges' }).expect(409);
    expect(ref.body.error).toBe('COST_MODE_LOCAL');
  });

  it('budgets：GET 并排给出预算；refresh 没有确认词 → 428 且不调用 Cost Explorer；确认后调用一次并缓存', async () => {
    const g = await request(budgetsApp).get('/api/lab/cost').set(admin()).expect(200);
    expect(g.body.mode).toBe('budgets');
    expect(g.body.budgets.items).toHaveLength(2);
    const no = await request(budgetsApp).post('/api/lab/cost/refresh').set(admin()).send({}).expect(428);
    expect(no.body.error).toBe('CONFIRMATION_REQUIRED');
    expect(ce.commandCalls(GetCostAndUsageCommand)).toHaveLength(0);
    const yes = await request(budgetsApp).post('/api/lab/cost/refresh').set(admin()).send({ confirm: 'ce-charges' }).expect(200);
    expect(yes.body.cached).toBe(false);
    const again = await request(budgetsApp).post('/api/lab/cost/refresh').set(admin()).send({ confirm: 'ce-charges' }).expect(200);
    expect(again.body.cached).toBe(true);
    expect(ce.commandCalls(GetCostAndUsageCommand)).toHaveLength(1);
    const g2 = await request(budgetsApp).get('/api/lab/cost').set(admin()).expect(200);
    expect(g2.body.explorer.cached).toBe(true);
  });
});
