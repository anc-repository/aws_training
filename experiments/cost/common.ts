/**
 * experiments/cost/common.ts —— cost 场景共用：经应用的 /api/lab/cost（仅管理员）读取本地清单、预算与 Cost Explorer 缓存。
 * 运行器不在工作台上调用 AWS SDK；Cost Explorer 只经 POST /api/lab/cost/refresh 调用，而且必须带确认词（按请求计费）。
 * 本文件与场景都不写任何价格：金额只来自 AWS Budgets / Cost Explorer 的实际账单数据，或学员注明出处抄录的单价。
 */
import type { ScenarioContext } from '../_lib/scenario.js';

export interface BillingItem { module: string; resource: string; hourly: boolean; quantity: number; enabledAt: string | null; runningHours: number | null; monthHours: number | null }
export interface BudgetView { name: string; role: string; exists: boolean; limit?: { amount: number; unit: string }; actual?: { amount: number; unit: string }; forecast?: { amount: number; unit: string } }
export interface CeResult { at: string; byModule: Array<{ module: string; amount: number; unit: string }>; untaggedShare: number | null; truncated: boolean; cached?: boolean }
export interface CostResponse {
  mode: string;
  local: { detail: string; hourly: BillingItem[]; usage: BillingItem[]; resourceHoursMonth: number; amount?: { value: number; currency: string } };
  budgets?: { items?: BudgetView[]; error?: string };
  subscriptions?: { pending?: number; confirmed?: number; error?: string };
  tagStatus?: { key: string; status: string };
  explorer?: CeResult;
  reminders: Array<{ kind: string; module: string; message: string }>;
}

/** POST /api/lab/cost/refresh 的确认词（与 backend/src/adapters/cost/lab-routes.ts 的 CE_CONFIRM 相同） */
export const CE_CONFIRM = 'ce-charges';

export async function getCost(ctx: ScenarioContext): Promise<CostResponse> {
  const r = await ctx.client.get('/api/lab/cost', { route: '/api/lab/cost', expect: [200] });
  if (r.status !== 200) throw new Error(`GET /api/lab/cost → ${r.status}：${r.text().slice(0, 200)}`);
  return r.json<CostResponse>();
}

/** 调用一次 Cost Explorer（按请求计费）：调用前必须已经得到 --param confirmCharges=yes */
export async function refreshCe(ctx: ScenarioContext, opts: { force?: boolean } = {}): Promise<CeResult> {
  const r = await ctx.client.post('/api/lab/cost/refresh', {
    route: '/api/lab/cost/refresh', json: { confirm: CE_CONFIRM, ...(opts.force ? { force: true } : {}) }, expect: [200], timeoutMs: 30_000,
  });
  if (r.status !== 200) throw new Error(`POST /api/lab/cost/refresh → ${r.status}：${r.text().slice(0, 300)}`);
  return r.json<CeResult>();
}
