/**
 * notification/compare —— 功能对照（04#notification 第 5 节步骤 6）。
 *
 *   npm run exp -- notification --label after --scenario compare
 *   （也可以直接运行：npx tsx experiments/notification/compare.ts —— 等价于上面的命令）
 *
 * 调用 POST /api/lab/notification/compare（仅管理员）：同一个 report.ready 测试事件分别经 db 驱动（逐个调用 EmailPort，接收人 =
 * 全部管理员）与 sns 驱动（一次 Publish）各发一次，测试事件不写站内信。返回两侧的耗时、调用次数与渠道；sns 档未启用时只有 db 一侧。
 * 该端点的实现在 backend/src/adapters/notification/compare.ts，路由由集成阶段登记；返回 404 时记 note 并结束。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineScenario } from '../_lib/scenario.js';

export default defineScenario({
  warmupWithRun: false,
  async run(ctx) {
    const res = await ctx.client.post('/api/lab/notification/compare', { route: '/api/lab/notification/compare', json: {}, expect: [200, 404, 501] });
    if (res.status !== 200) {
      ctx.note(`POST /api/lab/notification/compare 返回 ${res.status}（端点尚未登记或未实现）`);
      return;
    }
    const r = res.json<{
      recipients?: number; db?: { ms?: number; calls?: number; channels?: string[]; error?: string };
      sns?: { ms?: number; calls?: number; channels?: string[]; error?: string; skipped?: string };
    }>();
    ctx.finding('recipients', r.recipients);
    ctx.finding('db', r.db);
    ctx.finding('sns', r.sns);
    ctx.business('compare_db_ms', r.db?.ms);
    ctx.business('compare_db_calls', r.db?.calls);
    if (r.sns && !r.sns.skipped) {
      ctx.business('compare_sns_ms', r.sns.ms);
      ctx.business('compare_sns_calls', r.sns.calls);
      if (r.db?.ms !== undefined && r.sns.ms !== undefined && r.sns.ms > 0) ctx.finding('dbVsSnsMsRatio', Math.round((r.db.ms / r.sns.ms) * 100) / 100);
    }
  },
});

// 直接运行时转交给运行器（npm run exp -- notification --label <当前驱动> --scenario compare）
const invokedDirectly = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const { runExperiment, parseRunnerArgs } = await import('../_lib/runner.js');
  const label = process.argv.includes('--label') ? [] : ['--label', 'after'];
  const r = await runExperiment(parseRunnerArgs(['notification', '--scenario', 'compare', ...label, ...process.argv.slice(2)]));
  process.exit(r.code);
}
