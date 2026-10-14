// backend/src/modules/detectors/cost.ts —— cost 感知器（纯基础设施型；总纲 3.3；06#cost 第 1、10、11 节）
//
// 声明型开关 COST_MODE=local|budgets。本地估算**始终运行**（budgets 档也继续），二者并排展示“即时但不准”与“准确但滞后”：
//   - 本机：按 registry billing × 模块启用时长列出计费资源（adapters/cost/estimate.ts，不写单价；学员注明出处抄录单价后才估算金额），
//     输入（modules.state.json、cost-rates.yaml）是否可读决定 localHealth；
//   - 控制面（常规，60 秒缓存）：budgets:ViewBudget 读取两个预算的实际、预测、上限（us-east-1）；
//   - 控制面（深度，?deep=1）：ce:ListCostAllocationTags（Project 是否已激活，缓存 30 分钟）；sns:GetTopicAttributes（订阅是否已确认）。
//     不调用按请求计费的 GetCostAndUsage——它只在管理员显式确认后的手动刷新中调用（/api/lab/cost/refresh）。
// 状态（文档第 10 节）：
//   off      COST_MODE=local（detect() 仍可被调用：结果作为 localHealth 与 detail，即 /lab 顶栏的本地清单）
//   ok       两个预算存在且可读，标签已激活（已知时），订阅已确认
//   degraded 标签尚未生效（项目预算会一直显示 0）；订阅未确认；按小时计费的资源已运行超过 48 小时而项目预算实际仍为 0（inferred）；无凭证（CRED-004）
//   error    控制面确认预算不存在，或 AccessDenied
// 超支本身不改变状态：写在 detail 里，由 Budgets 自己发通知。瞬时失败（超时、限流）返回 { degraded, transient: true }。
// budgets 档的控制面读取在后台进行（adapters/aws/background-probe.ts，wave1-fix）：探针最多等 1.5 秒（深度 4 秒），不占用能力注册表
// 2 秒的探针预算；本地清单每次都重新计算并覆盖到结果里。
import { BackgroundProbe } from '../../adapters/aws/background-probe.js';
import { describeAwsError, isAwsAccessDenied, isAwsTransient } from '../../adapters/aws/clients.js';
import { BudgetsReader, type BudgetView, type TagStatus } from '../../adapters/cost/budgets.js';
import { estimateCost, type CostEstimate } from '../../adapters/cost/estimate.js';
import { platformMode } from '../../platform/mode.js';
import type { ProbeResult } from '../../ports/common.js';
import type { Detector, DetectorContext, DetectorFactory } from './types.js';

const INFER_HOURS = 48;

export interface CostDetectorOptions {
  now?: () => Date;
  uptimeSec?: () => number;
  platform?: () => boolean;
  reader?: BudgetsReader;
}

function fmtMoney(m?: { amount: number; unit: string }): string {
  return m ? `${m.unit} ${m.amount}` : '—';
}

function budgetText(b: BudgetView): string {
  if (!b.exists) return `${b.role === 'project' ? '项目' : b.role === 'account' ? '账号' : b.name} 预算不存在`;
  const label = b.role === 'project' ? '项目' : b.role === 'account' ? '账号' : b.name;
  return `${label}：本月实际 ${fmtMoney(b.actual)} · 预测 ${b.forecast ? fmtMoney(b.forecast) : '暂无'} · 上限 ${fmtMoney(b.limit)}`;
}

export class CostDetector implements Detector {
  readonly module = 'cost' as const;
  readonly reader?: BudgetsReader;
  private lastEstimate?: CostEstimate;
  private readonly bg = new BackgroundProbe({ label: 'AWS Budgets 控制面' });

  constructor(protected readonly ctx: DetectorContext, private readonly opts: CostDetectorOptions = {}) {
    const c = ctx.cfg.cost;
    if (opts.reader) this.reader = opts.reader;
    else if (c.COST_MODE === 'budgets' && ctx.aws.enabled) {
      this.reader = new BudgetsReader(ctx.aws, {
        budgetNames: (c.COST_BUDGET_NAMES ?? '').split(',').map((s) => s.trim()).filter(Boolean),
        ...(c.COST_TOPIC_ARN ? { topicArn: c.COST_TOPIC_ARN } : {}), tagKey: c.COST_TAG_KEY, tagValue: c.COST_TAG_VALUE,
      });
    }
  }

  /** 本地估算（每次重新计算：读两个小文件，不发请求） */
  estimate(): CostEstimate {
    const c = this.ctx.cfg.cost;
    const hb = c.COST_LOCAL_HOURS_BUDGET;
    this.lastEstimate = estimateCost({
      env: this.ctx.env, envDir: this.ctx.cfg.core.CLOUDALBUM_ENV_DIR,
      ...(c.COST_RATES_FILE ? { ratesFile: c.COST_RATES_FILE } : {}),
      ...(typeof hb === 'number' ? { hoursBudget: hb } : {}),
      ...(this.opts.now ? { now: this.opts.now() } : {}),
      ...(this.opts.uptimeSec ? { uptimeSec: this.opts.uptimeSec() } : {}),
      platform: this.opts.platform ? this.opts.platform() : platformMode(),
    });
    return this.lastEstimate;
  }

  async detect(opts: { deep?: boolean } = {}): Promise<ProbeResult> {
    const est = this.estimate();
    const data: Record<string, unknown> = {
      mode: this.ctx.cfg.cost.COST_MODE,
      local: {
        month: est.month, hourly: est.hourly.map((i) => ({ module: i.module, resource: i.resource, quantity: i.quantity, runningHours: i.runningHours, monthHours: i.monthHours, ...(i.amount ? { amount: i.amount } : {}) })),
        resourceHoursMonth: est.resourceHoursMonth, ...(est.amount ? { amount: est.amount } : {}), ...(est.hoursBudget ? { hoursBudget: est.hoursBudget } : {}),
        rates: est.rates, moduleState: est.moduleState,
      },
    };

    // ---- local：本地估算就是全部（localHealth = 输入是否可读）
    if (this.ctx.cfg.cost.COST_MODE !== 'budgets') {
      return {
        status: est.inputsOk ? 'ok' : 'degraded', confidence: 'observed', data,
        detail: est.inputsOk ? est.detail : `${est.detail} · ${est.problems.join('；')}`,
      };
    }

    // ---- budgets：本地清单 + 控制面
    const problems: string[] = est.inputsOk ? [] : [est.problems.join('；')];
    const status: ProbeResult['status'] = est.inputsOk ? 'ok' : 'degraded';
    if (!this.ctx.aws.enabled || !this.reader) {
      return { status: 'degraded', confidence: 'inferred', data, detail: `${est.detail} · 无凭证：读不到 AWS Budgets（CRED-004）` };
    }
    const reader = this.reader;
    const r = await this.bg.run(() => this.detectBudgets(reader, est, data, status, problems, opts), opts.deep ? { deep: true } : {});
    // 后台结果可能是上一轮的：本地清单总是用这一轮的
    return {
      ...r,
      data: { ...(r.data ?? {}), mode: data.mode, local: data.local },
      detail: r.detail.includes('本地：') ? r.detail : `${r.detail} · 本地：${est.detail}`,
    };
  }

  private async detectBudgets(
    reader: BudgetsReader, est: CostEstimate, data: Record<string, unknown>, initial: ProbeResult['status'], problems: string[],
    opts: { deep?: boolean },
  ): Promise<ProbeResult> {
    let status: ProbeResult['status'] = initial;
    let confidence: ProbeResult['confidence'] = 'confirmed';
    let transient = false;
    const degrade = (why: string) => {
      if (status === 'ok') status = 'degraded';
      problems.push(why);
    };

    let budgets: BudgetView[];
    try {
      budgets = await reader.budgets();
    } catch (e) {
      if (isAwsAccessDenied(e)) {
        return { status: 'error', confidence: 'confirmed', data, detail: `budgets:ViewBudget 被拒绝：${describeAwsError(e)}（cost 的 PolicyArn 未附加？）` };
      }
      return {
        status: 'degraded', confidence: 'inferred', data, detail: `${est.detail} · 读取预算失败：${describeAwsError(e)}`,
        ...(isAwsTransient(e) ? { transient: true } : {}),
      };
    }
    data.budgets = budgets;
    const missing = budgets.filter((b) => !b.exists);
    if (missing.length) {
      return { status: 'error', confidence: 'confirmed', data, detail: `控制面确认预算不存在：${missing.map((b) => b.name).join('、')}（重新执行 scripts/module enable cost）` };
    }

    // 订阅
    const subs = await reader.subscriptions();
    if (subs) {
      data.subscriptions = subs;
      if (subs.error) problems.push(`cost 主题不可读：${subs.error}`);
      else if ((subs.pending ?? 0) > 0) degrade('订阅未确认：预算告警邮件收不到');
    }

    // 成本分配标签（深度探针刷新；常规探针沿用缓存）
    let tag: TagStatus | undefined = reader.cachedTagStatus();
    if (opts.deep) {
      try {
        tag = await reader.tagStatus();
      } catch (e) {
        problems.push(`ce:ListCostAllocationTags 失败：${describeAwsError(e)}`);
        if (isAwsTransient(e)) transient = true;
      }
    }
    if (tag) {
      data.tag = tag;
      if (tag.status !== 'Active') degrade(`成本分配标签 ${tag.key} 尚未生效（${tag.status}；项目预算会一直显示 0）`);
    }

    // 推断：按小时计费的模块资源已运行超过 48 小时，项目预算的实际花费仍为 0 → 标签或数据有问题
    const project = budgets.find((b) => b.role === 'project');
    const longRunning = est.hourly.filter((i) => i.module !== 'ec2' && i.module !== 'platform' && (i.runningHours ?? 0) > INFER_HOURS);
    if (project && (project.actual?.amount ?? 0) === 0 && longRunning.length) {
      degrade(`${longRunning.map((i) => i.module).join('、')} 已运行超过 ${INFER_HOURS} 小时，项目预算的实际花费仍为 0（标签未生效或账单数据缺失？）`);
      confidence = 'inferred';
    }

    // 超支只写进 detail
    const over = budgets.filter((b) => (b.actualPct ?? 0) >= 100 || (b.forecastPct ?? 0) >= 100);
    const overText = over.length ? ` · 注意：${over.map((b) => `${b.role === 'project' ? '项目' : '账号'}预算${(b.actualPct ?? 0) >= 100 ? '实际已超' : '预测将超'}`).join('，')}` : '';
    return {
      status, confidence, data,
      detail: `AWS Budgets 预算 ${budgets.length} 个（${budgets.map(budgetText).join('；')}）${overText}${problems.length ? ` · ${problems.join('；')}` : ''} · 本地：${est.detail}`,
      ...(transient && status !== 'ok' ? { transient: true } : {}),
    };
  }

  /** 最近一次 detect() / estimate() 的本地估算（/api/lab/cost 与空开提醒复用） */
  lastLocalEstimate(): CostEstimate | undefined {
    return this.lastEstimate;
  }
}

export const costDetector: DetectorFactory = { module: 'cost', create: (ctx) => new CostDetector(ctx) };
