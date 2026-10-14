/**
 * cost/visibility-lag —— 可见性时延，适配为“同一时刻的快照”（06#cost 第 5 节步骤 1；cards svc-cost 第 6 步）。
 *
 *   npm run exp -- cost --label before --scenario visibility-lag                    # 只有本地清单
 *   npm run exp -- cost --label after  --scenario visibility-lag --upload           # 本地清单 + 两个预算
 *   npm run exp -- cost --label after  --scenario visibility-lag --param refreshCe=true --param confirmCharges=yes   # 再看 Cost Explorer（按请求计费）
 *
 * 本地清单按 registry 计费维度 × 模块启用时长列出资源，启用即出现；Budgets / Cost Explorer 依据实际账单数据，滞后数小时到一天。
 * 场景记录：本地清单中的每个按小时计费的模块资源已经可见多久、两个预算的实际 / 预测 / 上限，以及（可选）Cost Explorer 里
 * 这些模块是否已经出现费用。所有数据都来自服务端（/api/lab/cost），不写任何价格。
 */
import { boolParam, defineScenario, strParam } from '../_lib/scenario.js';
import { getCost, refreshCe, type CeResult } from './common.js';

export default defineScenario({
  warmupWithRun: false,
  async run(ctx) {
    const wantCe = boolParam(ctx, 'refreshCe', false);
    if (wantCe && strParam(ctx, 'confirmCharges', '') !== 'yes') {
      throw new Error('Cost Explorer API 按请求计费：同时加 --param confirmCharges=yes 才会调用（12 小时内复用缓存）');
    }
    const now = Date.now();
    const c = await getCost(ctx);
    ctx.finding('mode', c.mode);
    ctx.finding('localDetail', c.local.detail);
    const modules = c.local.hourly.filter((i) => i.module !== 'ec2' && i.module !== 'platform');
    const visible = modules.map((i) => ({
      module: i.module, resource: i.resource, enabledAt: i.enabledAt,
      visibleForSec: i.enabledAt ? Math.round((now - Date.parse(i.enabledAt)) / 1000) : null,
    }));
    ctx.finding('localHourlyModules', visible);
    ctx.business('local_hourly_items', c.local.hourly.length);
    ctx.business('local_module_items', modules.length);
    ctx.business('local_resource_hours_month', c.local.resourceHoursMonth);

    if (c.mode === 'budgets') {
      const items = c.budgets?.items ?? [];
      ctx.finding('budgets', items.length ? items : { error: c.budgets?.error ?? 'no data' });
      const project = items.find((b) => b.role === 'project');
      const account = items.find((b) => b.role === 'account');
      if (project?.actual) ctx.business('budgets_project_actual', project.actual.amount);
      if (account?.actual) ctx.business('budgets_account_actual', account.actual.amount);
      ctx.business('budgets_forecast_available', project?.forecast ? 1 : 0);
      if (c.tagStatus) ctx.finding('tagStatus', c.tagStatus);
      if (!project?.forecast) ctx.note('项目预算还没有预测：Budgets 需要约 5 周的用量历史才会生成预测（以官方文档为准）');
    }

    let ce: CeResult | undefined = c.explorer;
    if (wantCe) {
      if (c.mode !== 'budgets') throw new Error('Cost Explorer 需要 cost 已启用（COST_MODE=budgets）');
      ce = await refreshCe(ctx);
      ctx.note(ce.cached ? 'Cost Explorer：12 小时内的缓存结果（没有新的计费请求）' : 'Cost Explorer：调用了一次 ce:GetCostAndUsage（按请求计费）');
    }
    if (ce) {
      const withCost = new Set(ce.byModule.filter((m) => m.amount > 0).map((m) => m.module));
      const lag = visible.map((v) => ({ ...v, inCostExplorer: withCost.has(v.module) }));
      ctx.finding('costExplorer', { at: ce.at, byModule: ce.byModule, untaggedShare: ce.untaggedShare, truncated: ce.truncated });
      ctx.finding('lag', lag);
      ctx.business('ce_modules_with_cost', lag.filter((x) => x.inCostExplorer).length);
      ctx.business('modules_not_yet_in_ce', lag.filter((x) => !x.inCostExplorer).length);
    }
  },
});
