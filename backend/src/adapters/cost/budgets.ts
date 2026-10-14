// backend/src/adapters/cost/budgets.ts —— cost 的 AWS 一侧只读查询：AWS Budgets、成本分配标签、Cost Explorer（06#cost 第 2、10 节）
//
// - Budgets 与 Cost Explorer 的控制面在 us-east-1（全局服务；CRED-003 的例外清单包含 cost）：客户端一律传 { region: 'us-east-1' }。
// - budgets:ViewBudget（DescribeBudget）：两个预算的上限、本月实际、预测；结果缓存 60 秒（常规探针的节奏）。
//   Budgets 的 API 需要账号 ID：取自 COST_TOPIC_ARN（cost 栈输出），没有时退回 sts:GetCallerIdentity。
// - ce:ListCostAllocationTags：Project 标签是否已激活（只在深度探针中调用，结果缓存 30 分钟——Cost Explorer API 可能按请求计费，以官方定价为准）。
// - ce:GetCostAndUsage：**按请求计费**，只在管理员显式确认后的手动刷新时调用（COST_CE_QUERY=manual），绝不轮询；
//   本月按天、按 Module 标签分组，结果缓存 12 小时；只取第一页（每一页都单独计费），有下一页时标注 truncated。
// - sns:GetTopicAttributes：cost 主题的订阅是否已确认。
// 控制面调用经 withAwsRetry（每次尝试单独超时，只重试瞬时错误）；本文件不写任何价格。
import type { AwsClients } from '../aws/clients.js';
import { describeAwsError, isAwsNotFound, loadAwsPackage, withAwsRetry } from '../aws/clients.js';

export const GLOBAL_REGION = 'us-east-1';
const BUDGET_CACHE_MS = 60_000;
const TAG_CACHE_MS = 30 * 60_000;
const TOPIC_CACHE_MS = 60_000;
export const CE_CACHE_MS = 12 * 3600_000;

export interface Money { amount: number; unit: string }

export interface BudgetView {
  name: string;
  role: 'project' | 'account' | 'other';
  exists: boolean;
  limit?: Money;
  actual?: Money;
  forecast?: Money;
  timeUnit?: string;
  budgetType?: string;
  /** 实际花费占上限的百分比 */
  actualPct?: number;
  forecastPct?: number;
  error?: string;
  errorName?: string;
}

export interface TagStatus { key: string; status: 'Active' | 'Inactive' | 'NotFound'; lastUpdated?: string; checkedAt: string }

export interface CeResult {
  at: string;
  timePeriod: { start: string; end: string };
  /** 按 Module 标签分组的本月合计（'' = 无标签） */
  byModule: Array<{ module: string; amount: number; unit: string }>;
  days: Array<{ date: string; groups: Array<{ module: string; amount: number }> }>;
  untaggedShare: number | null;
  truncated: boolean;
  requests: number;
}

export interface BudgetsReaderConfig {
  budgetNames: string[];
  topicArn?: string;
  tagKey: string;
  tagValue: string;
}

export function budgetRole(name: string, index: number): BudgetView['role'] {
  if (/-project-monthly$/.test(name)) return 'project';
  if (/-account-monthly$/.test(name)) return 'account';
  return index === 0 ? 'project' : index === 1 ? 'account' : 'other';
}

function money(m?: { Amount?: string; Unit?: string }): Money | undefined {
  if (!m?.Amount) return undefined;
  const amount = Number(m.Amount);
  return Number.isFinite(amount) ? { amount: Math.round(amount * 100) / 100, unit: m.Unit ?? 'USD' } : undefined;
}

function pct(a?: Money, b?: Money): number | undefined {
  if (!a || !b || !b.amount) return undefined;
  return Math.round((a.amount / b.amount) * 1000) / 10;
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export class BudgetsReader {
  private budgetCache?: { at: number; value: BudgetView[] };
  private tagCache?: TagStatus;
  private topicCache?: { at: number; pending?: number; confirmed?: number; error?: string };
  private ceCache?: CeResult;
  private account?: string;

  constructor(private readonly aws: AwsClients, private readonly cfg: BudgetsReaderConfig, private readonly now: () => number = () => Date.now()) {}

  async accountId(): Promise<string> {
    if (this.account) return this.account;
    const fromArn = /^arn:aws[a-z-]*:sns:[a-z0-9-]+:(\d{12}):/.exec(this.cfg.topicArn ?? '')?.[1];
    if (fromArn) return (this.account = fromArn);
    const sdk = await loadAwsPackage('@aws-sdk/client-sts', () => import('@aws-sdk/client-sts'));
    const sts = await this.aws.sts();
    const r = await withAwsRetry(() => sts.send(new sdk.GetCallerIdentityCommand({})), { attempts: 2, timeoutMs: 3000 });
    if (!r.Account) throw new Error('sts:GetCallerIdentity 没有返回账号 ID');
    return (this.account = r.Account);
  }

  /** 两个预算（缓存 60 秒）。单个预算不存在时 exists=false；权限、网络错误照常抛出。 */
  async budgets(opts: { refresh?: boolean } = {}): Promise<BudgetView[]> {
    const now = this.now();
    if (!opts.refresh && this.budgetCache && now - this.budgetCache.at < BUDGET_CACHE_MS) return this.budgetCache.value;
    const sdk = await loadAwsPackage('@aws-sdk/client-budgets', () => import('@aws-sdk/client-budgets'));
    const client = await this.aws.budgets({ region: GLOBAL_REGION });
    const accountId = await this.accountId();
    const out: BudgetView[] = [];
    for (const [i, name] of this.cfg.budgetNames.entries()) {
      const role = budgetRole(name, i);
      try {
        const r = await withAwsRetry(() => client.send(new sdk.DescribeBudgetCommand({ AccountId: accountId, BudgetName: name })), { attempts: 3, timeoutMs: 4000 });
        const b = r.Budget;
        const limit = money(b?.BudgetLimit);
        const actual = money(b?.CalculatedSpend?.ActualSpend);
        const forecast = money(b?.CalculatedSpend?.ForecastedSpend);
        const ap = pct(actual, limit);
        const fp = pct(forecast, limit);
        out.push({
          name, role, exists: true, ...(limit ? { limit } : {}), ...(actual ? { actual } : {}), ...(forecast ? { forecast } : {}),
          ...(b?.TimeUnit ? { timeUnit: b.TimeUnit } : {}), ...(b?.BudgetType ? { budgetType: b.BudgetType } : {}),
          ...(ap !== undefined ? { actualPct: ap } : {}), ...(fp !== undefined ? { forecastPct: fp } : {}),
        });
      } catch (e) {
        if (isAwsNotFound(e)) out.push({ name, role, exists: false, error: '预算不存在', errorName: 'NotFoundException' });
        else throw e;
      }
    }
    this.budgetCache = { at: now, value: out };
    return out;
  }

  /** 最近一次已知的标签状态（不发请求） */
  cachedTagStatus(): TagStatus | undefined {
    return this.tagCache;
  }

  /** 成本分配标签是否已激活（ce:ListCostAllocationTags；缓存 30 分钟） */
  async tagStatus(opts: { refresh?: boolean } = {}): Promise<TagStatus> {
    const now = this.now();
    if (!opts.refresh && this.tagCache && now - Date.parse(this.tagCache.checkedAt) < TAG_CACHE_MS) return this.tagCache;
    const sdk = await loadAwsPackage('@aws-sdk/client-cost-explorer', () => import('@aws-sdk/client-cost-explorer'));
    const ce = await this.aws.costExplorer({ region: GLOBAL_REGION });
    const r = await withAwsRetry(() => ce.send(new sdk.ListCostAllocationTagsCommand({ TagKeys: [this.cfg.tagKey], MaxResults: 10 })), { attempts: 2, timeoutMs: 4000 });
    const t = (r.CostAllocationTags ?? []).find((x) => x.TagKey === this.cfg.tagKey);
    this.tagCache = {
      key: this.cfg.tagKey, status: t?.Status === 'Active' ? 'Active' : t ? 'Inactive' : 'NotFound',
      ...(t?.LastUpdatedDate ? { lastUpdated: String(t.LastUpdatedDate) } : {}), checkedAt: new Date(now).toISOString(),
    };
    return this.tagCache;
  }

  /** cost 主题的订阅（缓存 60 秒；失败时返回 error，不抛出） */
  async subscriptions(): Promise<{ pending?: number; confirmed?: number; error?: string } | undefined> {
    const arn = this.cfg.topicArn;
    if (!arn) return undefined;
    const now = this.now();
    if (this.topicCache && now - this.topicCache.at < TOPIC_CACHE_MS) return this.topicCache;
    try {
      const sdk = await loadAwsPackage('@aws-sdk/client-sns', () => import('@aws-sdk/client-sns'));
      const sns = await this.aws.sns();
      const r = await withAwsRetry(() => sns.send(new sdk.GetTopicAttributesCommand({ TopicArn: arn })), { attempts: 2, timeoutMs: 3000 });
      this.topicCache = { at: now, pending: Number(r.Attributes?.SubscriptionsPending ?? 0), confirmed: Number(r.Attributes?.SubscriptionsConfirmed ?? 0) };
    } catch (e) {
      this.topicCache = { at: now, error: describeAwsError(e) };
    }
    return this.topicCache;
  }

  /** 最近一次 Cost Explorer 结果（不发请求） */
  cachedCostAndUsage(): CeResult | undefined {
    return this.ceCache && this.now() - Date.parse(this.ceCache.at) < CE_CACHE_MS ? this.ceCache : undefined;
  }

  /**
   * ce:GetCostAndUsage（按请求计费）：调用方必须先取得显式确认（路由层校验 confirm）。缓存 12 小时：缓存有效时直接返回缓存，
   * 除非 force（同样需要确认）。
   */
  async costAndUsage(opts: { confirmed: boolean; force?: boolean }): Promise<{ result: CeResult; cached: boolean }> {
    if (!opts.confirmed) throw Object.assign(new Error('Cost Explorer API 按请求计费：需要显式确认（confirm）'), { name: 'ConfirmationRequired' });
    const hit = this.cachedCostAndUsage();
    if (hit && !opts.force) return { result: hit, cached: true };
    const sdk = await loadAwsPackage('@aws-sdk/client-cost-explorer', () => import('@aws-sdk/client-cost-explorer'));
    const ce = await this.aws.costExplorer({ region: GLOBAL_REGION });
    const now = new Date(this.now());
    const start = ymd(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)));
    const end = ymd(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)));
    // 不重试：每次请求都计费，失败就让管理员决定是否再点一次
    const r = await ce.send(new sdk.GetCostAndUsageCommand({
      TimePeriod: { Start: start, End: end }, Granularity: 'DAILY', Metrics: ['UnblendedCost'], GroupBy: [{ Type: 'TAG', Key: 'Module' }],
    }));
    const totals = new Map<string, { amount: number; unit: string }>();
    const days: CeResult['days'] = [];
    for (const day of r.ResultsByTime ?? []) {
      const groups: Array<{ module: string; amount: number }> = [];
      for (const g of day.Groups ?? []) {
        const key = (g.Keys?.[0] ?? '').replace(/^Module\$/, '');
        const m = g.Metrics?.UnblendedCost;
        const amount = Number(m?.Amount ?? 0);
        if (!Number.isFinite(amount)) continue;
        groups.push({ module: key, amount: Math.round(amount * 100) / 100 });
        const cur = totals.get(key) ?? { amount: 0, unit: m?.Unit ?? 'USD' };
        cur.amount += amount;
        totals.set(key, cur);
      }
      days.push({ date: day.TimePeriod?.Start ?? '', groups });
    }
    const byModule = [...totals.entries()].map(([module, v]) => ({ module, amount: Math.round(v.amount * 100) / 100, unit: v.unit }))
      .sort((a, b) => b.amount - a.amount);
    const sum = byModule.reduce((a, b) => a + b.amount, 0);
    const untagged = byModule.find((b) => b.module === '')?.amount ?? 0;
    this.ceCache = {
      at: now.toISOString(), timePeriod: { start, end }, byModule, days,
      untaggedShare: sum > 0 ? Math.round((untagged / sum) * 1000) / 10 : null, truncated: Boolean(r.NextPageToken), requests: 1,
    };
    return { result: this.ceCache, cached: false };
  }
}
