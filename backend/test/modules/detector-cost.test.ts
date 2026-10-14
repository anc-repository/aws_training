// cost：本地估算（registry 计费维度 × 启用时长；单价只来自注明出处的 cost-rates.yaml）、感知器的 local / budgets 两档
// （Budgets DescribeBudget、ce:ListCostAllocationTags、sns:GetTopicAttributes 经 aws-sdk-client-mock），Cost Explorer 的显式确认与缓存，
// 空开提醒（SQLite）。不发出任何网络请求，不写任何价格。
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BudgetsClient, DescribeBudgetCommand } from '@aws-sdk/client-budgets';
import { CostExplorerClient, GetCostAndUsageCommand, ListCostAllocationTagsCommand } from '@aws-sdk/client-cost-explorer';
import { GetTopicAttributesCommand, SNSClient } from '@aws-sdk/client-sns';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { lazyAwsClients } from '../../src/adapters/aws/clients.js';
import { BudgetsReader, budgetRole } from '../../src/adapters/cost/budgets.js';
import { estimateCost, loadCostRates, monthEnabledMs, type ModuleStateFile } from '../../src/adapters/cost/estimate.js';
import { idleCandidates, runIdleCheck } from '../../src/adapters/cost/idle.js';
import { CostDetector } from '../../src/modules/detectors/cost.js';
import { REGISTRY } from '../../src/modules/registry.js';
import { makeLocalDeps } from '../contract/_local-deps.js';
import { ENABLE } from '../helpers/config.js';
import { seedUser } from '../helpers/media-fixtures.js';
import { awsError, fakeCredentials, testConfig } from '../adapters/aws/helpers.js';

const budgets = mockClient(BudgetsClient);
const ce = mockClient(CostExplorerClient);
const sns = mockClient(SNSClient);
const TOPIC = 'arn:aws:sns:ap-northeast-1:123456789012:cloudalbum-lab-cost';
const NOW = new Date('2026-10-14T12:00:00Z');

beforeEach(() => {
  budgets.on(DescribeBudgetCommand).callsFake((input: { BudgetName: string }) => ({
    Budget: {
      BudgetName: input.BudgetName, BudgetType: 'COST', TimeUnit: 'MONTHLY', BudgetLimit: { Amount: '20.0', Unit: 'USD' },
      CalculatedSpend: { ActualSpend: { Amount: input.BudgetName.includes('project') ? '3.5' : '5.25', Unit: 'USD' } },
    },
  }));
  sns.on(GetTopicAttributesCommand).resolves({ Attributes: { SubscriptionsPending: '0', SubscriptionsConfirmed: '1' } });
  ce.on(ListCostAllocationTagsCommand).resolves({ CostAllocationTags: [{ TagKey: 'Project', Type: 'UserDefined', Status: 'Active' }] });
});
afterEach(() => {
  budgets.reset();
  ce.reset();
  sns.reset();
});

const tmpEnvDir = () => mkdtempSync(path.join(os.tmpdir(), 'cloudalbum-cost-'));
const enabledState = (at: string, extra: ModuleStateFile['history'] = []): ModuleStateFile => ({
  modules: { database: { enabled: true, driver: 'postgres', enabledAt: at } },
  history: [{ op: 'enable', module: 'database', at }, ...extra],
});

describe('本地估算（estimate.ts）', () => {
  it('L0：只有 ec2 的计费条目；按小时计费的 EC2 实例与公网 IPv4 进入清单；没有 cost-rates.yaml 时不显示金额', () => {
    const est = estimateCost({ env: {}, envDir: tmpEnvDir(), now: NOW, uptimeSec: 52 * 3600, moduleState: null });
    expect(est.hourly.map((i) => i.module)).toEqual(['ec2', 'ec2']);
    expect(est.hourly[0]!.runningHours).toBe(52);
    expect(est.usage.length).toBeGreaterThan(0);
    expect(est.detail).toContain('EC2 实例');
    expect(est.detail).toContain('未填写 cost-rates.yaml，不显示金额');
    expect(est.amount).toBeUndefined();
    expect(est.inputsOk).toBe(true);
  });

  it('已启用的模块按 registry billing 进入清单；本地档不进入；本月累计小时由启停历史重建', () => {
    const env = { ...ENABLE.rds, CACHE_DRIVER: 'memory' };
    const state = enabledState('2026-10-14T09:00:00Z', [
      { op: 'disable', module: 'database', at: '2026-10-14T10:00:00Z' }, { op: 'enable', module: 'database', at: '2026-10-14T11:00:00Z' },
    ]);
    state.modules!.database!.enabledAt = '2026-10-14T11:00:00Z';
    const est = estimateCost({ env, envDir: tmpEnvDir(), now: NOW, uptimeSec: 3600, moduleState: state });
    const rds = est.hourly.filter((i) => i.module === 'database');
    expect(rds.length).toBeGreaterThan(0);
    expect(rds[0]!.runningHours).toBe(1);
    expect(rds[0]!.monthHours).toBe(2);                             // 9-10 点 + 11-12 点
    expect(est.items.some((i) => i.module === 'cache')).toBe(false);  // memory 是本地档
  });

  it('monthEnabledMs：月初以前启用、本月没有记录 → 从月初算；没有记录也没有 enabledAt → null', () => {
    const before: ModuleStateFile = { modules: { cache: { enabled: true, enabledAt: '2026-09-20T00:00:00Z' } }, history: [{ op: 'enable', module: 'cache', at: '2026-09-20T00:00:00Z' }] };
    expect(monthEnabledMs('cache', before, NOW)! / 3600_000).toBe(13 * 24 + 12);
    expect(monthEnabledMs('cache', { modules: { cache: { enabled: true } } }, NOW)).toBeNull();
    expect(monthEnabledMs('cache', { modules: {} }, NOW)).toBe(0);
    expect(monthEnabledMs('cache', null, NOW)).toBeNull();
  });

  it('cost-rates.yaml：只有注明 https 出处与抄录日期、resource 与 registry 逐字一致的按小时条目参与估算（CFG-010）', () => {
    const dir = tmpEnvDir();
    const ec2Hourly = REGISTRY.ec2.billing!.find((b) => b.hourly)!.resource;
    writeFileSync(path.join(dir, 'cost-rates.yaml'), [
      'currency: USD', 'region: ap-northeast-1', 'entries:',
      `  - { resource: "${ec2Hourly}", unit: hour, rate: 0.5, source: "https://aws.amazon.com/ec2/pricing/on-demand/", retrievedAt: 2026-10-01 }`,
      '  - { resource: "不存在的资源", unit: hour, rate: 1, source: "https://aws.amazon.com/", retrievedAt: 2026-10-01 }',
      `  - { resource: "${REGISTRY.ec2.billing!.filter((b) => b.hourly)[1]!.resource}", unit: hour, rate: 0.1 }`,
    ].join('\n'));
    const rates = loadCostRates(path.join(dir, 'cost-rates.yaml'))!;
    expect(rates.qualified).toHaveLength(1);
    expect(rates.rejected.map((r) => r.why)).toEqual(['resource 与 registry billing.resource 对不上', '缺少 source（官方定价页 URL）']);
    const est = estimateCost({ env: {}, envDir: dir, now: NOW, uptimeSec: 10 * 3600, moduleState: null });
    expect(est.amount).toMatchObject({ value: 5, currency: 'USD', items: 1 });
    expect(est.hourly[0]!.amount).toMatchObject({ rate: 0.5, source: 'https://aws.amazon.com/ec2/pricing/on-demand/', retrievedAt: '2026-10-01' });
    expect(est.detail).toContain('估算 USD 5');
    expect(est.detail).toContain('2 个单价条目未注明出处');
  });

  it('资源小时预算（不涉及价格）与平台模式的工作台计费维度（只有维度）', () => {
    const est = estimateCost({ env: {}, envDir: tmpEnvDir(), now: NOW, uptimeSec: 13 * 24 * 3600 + 12 * 3600, moduleState: null, hoursBudget: 400, platform: true });
    expect(est.resourceHoursMonth).toBe(2 * (13 * 24 + 12));
    expect(est.hoursBudget).toMatchObject({ limit: 400, level: 'over100' });
    const ws = est.items.filter((i) => i.module === 'platform');
    expect(ws.map((i) => i.resource)).toEqual(['平台工作台 EC2 实例', '平台工作台 公网 IPv4', '平台工作台 EBS 卷']);
    expect(ws.every((i) => i.amount === undefined && i.monthHours === null)).toBe(true);
    expect(est.detail).toContain('平台工作台');
  });

  it('modules.state.json 不可读 → inputsOk=false（localHealth degraded）', () => {
    const dir = tmpEnvDir();
    writeFileSync(path.join(dir, 'modules.state.json'), '{not json');
    const est = estimateCost({ env: {}, envDir: dir, now: NOW, uptimeSec: 60 });
    expect(est.inputsOk).toBe(false);
    expect(est.moduleState).toBe('unreadable');
  });
});

function detector(env: Record<string, string>, opts: { credentials?: boolean; uptimeSec?: number } = {}) {
  const { cfg, effective } = testConfig(env);
  const aws = lazyAwsClients({ region: cfg.core.AWS_REGION, credentials: opts.credentials === false ? null : fakeCredentials });
  return new CostDetector({ cfg, env: effective, aws }, { now: () => NOW, uptimeSec: () => opts.uptimeSec ?? 3600, platform: () => false });
}

const budgetsEnv = { ...ENABLE.iamRole, ...ENABLE.cost, COST_TOPIC_ARN: TOPIC };

describe('CostDetector', () => {
  it('local：detect() 返回本地清单作为 detail（localHealth），不调用任何 AWS API', async () => {
    const d = detector({});
    const r = await d.detect({});
    expect(r).toMatchObject({ status: 'ok', confidence: 'observed' });
    expect(r.detail).toContain('当前按小时计费的资源');
    expect(budgets.calls()).toHaveLength(0);
    expect(d.reader).toBeUndefined();
  });

  it('budgets：两个预算可读、订阅已确认 → ok；detail 并排给出“实际 / 预测 / 上限”与本地清单；账号 ID 取自主题 ARN；客户端在 us-east-1', async () => {
    const d = detector(budgetsEnv);
    const r = await d.detect({});
    expect(r.status).toBe('ok');
    expect(r.detail).toContain('项目：本月实际 USD 3.5');
    expect(r.detail).toContain('预测 暂无');
    expect(r.detail).toContain('本地：当前按小时计费的资源');
    const calls = budgets.commandCalls(DescribeBudgetCommand);
    expect(calls.map((c) => c.args[0].input)).toEqual([
      { AccountId: '123456789012', BudgetName: 'cloudalbum-lab-project-monthly' },
      { AccountId: '123456789012', BudgetName: 'cloudalbum-lab-account-monthly' },
    ]);
    expect(await budgets.call(0).thisValue.config.region()).toBe('us-east-1');
    await d.detect({});                                              // 60 秒缓存
    expect(budgets.commandCalls(DescribeBudgetCommand)).toHaveLength(2);
    expect(ce.calls()).toHaveLength(0);                              // 常规探针不调用 Cost Explorer
  });

  it('深度探针：成本分配标签未激活 → degraded（会话内等不到，卡片用 anyOf 显式允许）；订阅未确认 → degraded', async () => {
    ce.on(ListCostAllocationTagsCommand).resolves({ CostAllocationTags: [{ TagKey: 'Project', Status: 'Inactive' }] });
    const d = detector(budgetsEnv);
    const r = await d.detect({ deep: true });
    expect(r.status).toBe('degraded');
    expect(r.detail).toContain('成本分配标签 Project 尚未生效');
    expect(ce.commandCalls(ListCostAllocationTagsCommand)[0]!.args[0].input).toMatchObject({ TagKeys: ['Project'] });
    const again = await d.detect({});                                 // 常规探针沿用缓存的标签状态
    expect(again.status).toBe('degraded');
    expect(ce.commandCalls(ListCostAllocationTagsCommand)).toHaveLength(1);

    sns.on(GetTopicAttributesCommand).resolves({ Attributes: { SubscriptionsPending: '1', SubscriptionsConfirmed: '0' } });
    const s = await detector(budgetsEnv).detect({});
    expect(s.status).toBe('degraded');
    expect(s.detail).toContain('订阅未确认');
  });

  it('预算不存在或 AccessDenied → error；超时 → degraded transient；无凭证 → degraded inferred（CRED-004）', async () => {
    budgets.on(DescribeBudgetCommand).rejects(awsError('NotFoundException', 400, 'budget not found'));
    expect((await detector(budgetsEnv).detect({})).status).toBe('error');
    budgets.on(DescribeBudgetCommand).rejects(awsError('AccessDeniedException', 400, 'not authorized to perform budgets:ViewBudget'));
    const denied = await detector(budgetsEnv).detect({});
    expect(denied.status).toBe('error');
    expect(denied.detail).toContain('budgets:ViewBudget');
    budgets.on(DescribeBudgetCommand).rejects(awsError('ThrottlingException', 400, 'Rate exceeded'));
    expect(await detector(budgetsEnv).detect({})).toMatchObject({ status: 'degraded', transient: true });
    const none = await detector({ ...ENABLE.cost }, { credentials: false }).detect({});
    expect(none).toMatchObject({ status: 'degraded', confidence: 'inferred' });
    expect(none.detail).toContain('CRED-004');
  });

  it('推断：按小时计费的模块已运行超过 48 小时，项目预算实际仍为 0 → degraded（inferred）；超支只写进 detail', async () => {
    budgets.on(DescribeBudgetCommand).callsFake((input: { BudgetName: string }) => ({
      Budget: {
        BudgetName: input.BudgetName, TimeUnit: 'MONTHLY', BudgetLimit: { Amount: '10', Unit: 'USD' },
        CalculatedSpend: { ActualSpend: { Amount: input.BudgetName.includes('project') ? '0' : '12', Unit: 'USD' } },
      },
    }));
    const dir = tmpEnvDir();
    writeFileSync(path.join(dir, 'modules.state.json'), JSON.stringify(enabledState('2026-10-10T00:00:00Z')));
    const d = detector({ ...budgetsEnv, ...ENABLE.rds, CLOUDALBUM_ENV_DIR: dir });
    const r = await d.detect({});
    expect(r).toMatchObject({ status: 'degraded', confidence: 'inferred' });
    expect(r.detail).toContain('项目预算的实际花费仍为 0');
    expect(r.detail).toContain('账号预算实际已超');
  });

  it('budgetRole：按名称后缀识别项目 / 账号预算', () => {
    expect(budgetRole('cloudalbum-lab-account-monthly', 0)).toBe('account');
    expect(budgetRole('x', 0)).toBe('project');
  });
});

describe('Cost Explorer（按请求计费）', () => {
  it('没有显式确认就不发请求；确认后调用一次 GetCostAndUsage（本月按天、按 Module 标签），12 小时内复用缓存', async () => {
    ce.on(GetCostAndUsageCommand).resolves({
      ResultsByTime: [
        { TimePeriod: { Start: '2026-10-13', End: '2026-10-14' }, Groups: [
          { Keys: ['Module$database'], Metrics: { UnblendedCost: { Amount: '1.20', Unit: 'USD' } } },
          { Keys: ['Module$'], Metrics: { UnblendedCost: { Amount: '0.80', Unit: 'USD' } } },
        ] },
      ],
    });
    const { cfg } = testConfig(budgetsEnv);
    let now = NOW.getTime();
    const r = new BudgetsReader(lazyAwsClients({ region: cfg.core.AWS_REGION, credentials: fakeCredentials }), { budgetNames: [], tagKey: 'Project', tagValue: 'CloudAlbum' }, () => now);
    await expect(r.costAndUsage({ confirmed: false })).rejects.toThrow('需要显式确认');
    expect(ce.commandCalls(GetCostAndUsageCommand)).toHaveLength(0);
    const first = await r.costAndUsage({ confirmed: true });
    expect(first.cached).toBe(false);
    expect(first.result).toMatchObject({ timePeriod: { start: '2026-10-01', end: '2026-10-15' }, untaggedShare: 40, truncated: false });
    expect(first.result.byModule).toEqual([{ module: 'database', amount: 1.2, unit: 'USD' }, { module: '', amount: 0.8, unit: 'USD' }]);
    expect(ce.commandCalls(GetCostAndUsageCommand)[0]!.args[0].input).toMatchObject({ Granularity: 'DAILY', GroupBy: [{ Type: 'TAG', Key: 'Module' }] });
    const second = await r.costAndUsage({ confirmed: true });
    expect(second.cached).toBe(true);
    expect(ce.commandCalls(GetCostAndUsageCommand)).toHaveLength(1);
    now += 13 * 3600_000;
    expect((await r.costAndUsage({ confirmed: true })).cached).toBe(false);
    expect(ce.commandCalls(GetCostAndUsageCommand)).toHaveLength(2);
  });
});

describe('空开提醒（idle.ts）', () => {
  it('按小时计费的模块资源连续启用超过阈值、且这段时间没有实验 → 提醒；ec2 不提醒；有实验时不提醒', async () => {
    const est = estimateCost({ env: ENABLE.rds, envDir: tmpEnvDir(), now: NOW, uptimeSec: 100 * 3600, moduleState: enabledState('2026-10-14T06:00:00Z') });
    const c = idleCandidates(est, { idleHours: 4, lastActivity: null, now: NOW });
    expect(c.length).toBeGreaterThan(0);
    expect(c.every((x) => x.module === 'database')).toBe(true);
    expect(c[0]!.message).toContain('profile apply l0-ec2');
    expect(idleCandidates(est, { idleHours: 4, lastActivity: '2026-10-14T11:00:00Z', now: NOW })).toEqual([]);
    expect(idleCandidates(est, { idleHours: 8, lastActivity: null, now: NOW })).toEqual([]);
  });

  it('runIdleCheck：写站内信与邮件，每个资源每天只提醒一次', async () => {
    const l = await makeLocalDeps({ role: 'worker' });
    try {
      await seedUser(l.db, { role: 'admin', email: 'boss@example.com' });
      const sent: string[] = [];
      const email = {
        meta: { module: 'email' as const, driver: 'outbox', awsService: null, authoritative: false },
        probe: async () => ({ status: 'ok' as const, detail: '' }), listRecent: async () => [],
        send: async (m: { subject: string }) => { sent.push(m.subject); return { messageId: 'x', transport: 'outbox' as const, delivered: true }; },
      };
      const estimate = () => estimateCost({ env: ENABLE.rds, envDir: l.envDir, now: NOW, uptimeSec: 3600, moduleState: enabledState('2026-10-14T06:00:00Z') });
      const r1 = await runIdleCheck({ db: l.db, estimate, idleHours: 4, email, now: () => NOW });
      expect(r1.length).toBeGreaterThan(0);
      expect(sent.length).toBe(r1.length);
      expect(await l.db('notifications').where({ type: 'cost.idle' })).toHaveLength(r1.length);
      const r2 = await runIdleCheck({ db: l.db, estimate, idleHours: 4, email, now: () => NOW });
      expect(r2).toEqual([]);
    } finally {
      await l.close();
    }
  });
});
