/**
 * cost/tag-coverage —— 标签覆盖（06#cost 第 5 节步骤 2；cards svc-cost 第 7 步，选做）。
 *
 *   npm run exp -- cost --label after --scenario tag-coverage --param confirmCharges=yes --upload
 *
 * 调用一次 POST /api/lab/cost/refresh（ce:GetCostAndUsage，本月按天、按 Module 标签分组；**按请求计费**，所以必须
 * --param confirmCharges=yes；12 小时内复用缓存，--param force=true 才会再调用一次），记录：
 *   - “无标签”一组（Module 标签为空）占本月费用的比例：不带标签的费用只会进入账号预算；标签激活之前的费用不按标签分组；
 *   - 项目预算（按 Project=CloudAlbum 筛选）与账号预算（不筛选）的实际花费差额。
 * 金额全部来自 AWS 的账单数据，场景不写任何价格。
 */
import { boolParam, defineScenario, strParam } from '../_lib/scenario.js';
import { getCost, refreshCe } from './common.js';

export default defineScenario({
  warmupWithRun: false,
  async run(ctx) {
    if (strParam(ctx, 'confirmCharges', '') !== 'yes') {
      throw new Error('Cost Explorer API 按请求计费：加 --param confirmCharges=yes 才会调用（12 小时内复用缓存）');
    }
    const before = await getCost(ctx);
    if (before.mode !== 'budgets') throw new Error('Cost Explorer 需要 cost 已启用（COST_MODE=budgets）');
    const ce = await refreshCe(ctx, { force: boolParam(ctx, 'force', false) });
    ctx.note(ce.cached ? 'Cost Explorer：12 小时内的缓存结果（没有新的计费请求）' : 'Cost Explorer：调用了一次 ce:GetCostAndUsage（按请求计费）');
    ctx.finding('costExplorer', { at: ce.at, byModule: ce.byModule, untaggedShare: ce.untaggedShare, truncated: ce.truncated });
    ctx.business('ce_groups', ce.byModule.length);
    if (ce.untaggedShare !== null) ctx.business('untagged_share_pct', ce.untaggedShare);
    if (ce.truncated) ctx.note('结果有下一页（只取了第一页：每一页都单独计费）');

    const items = before.budgets?.items ?? [];
    const project = items.find((b) => b.role === 'project');
    const account = items.find((b) => b.role === 'account');
    ctx.finding('budgets', items);
    if (project?.actual && account?.actual) ctx.business('project_account_gap', Math.round((account.actual.amount - project.actual.amount) * 100) / 100);
    if (before.tagStatus) ctx.finding('tagStatus', before.tagStatus);
    if (before.tagStatus && before.tagStatus.status !== 'Active') {
      ctx.note(`成本分配标签 ${before.tagStatus.key} 尚未生效：项目预算与按标签的分组会一直是 0（激活有延迟，以官方文档为准）`);
    }
  },
});
