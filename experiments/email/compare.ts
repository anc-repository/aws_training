/**
 * email/compare —— 功能对照（04#email 第 5 节步骤 4）。
 *
 *   npm run exp -- email --label after --scenario compare --param to=<你已验证的邮箱>
 *   （也可以直接运行：npx tsx experiments/email/compare.ts --param to=<你已验证的邮箱>）
 *
 * 调用 POST /api/lab/email/compare {to}（仅管理员）：同一封邮件（同一份 MIME 构造代码）分别经 outbox 驱动（写本机 .eml）与
 * ses 驱动（SendEmail）各发一次，只发给你指定的地址；并排返回耗时与结果。实现见 backend/src/adapters/email/compare.ts，
 * 路由由集成阶段登记；返回 404 时记 note 并结束。沙盒期 to 必须是已验证地址，否则 ses 一侧为 MessageRejected。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineScenario, strParam } from '../_lib/scenario.js';

interface Run { ms?: number; transport?: string; delivered?: boolean; messageId?: string; error?: string; skipped?: string }

export default defineScenario({
  warmupWithRun: false,
  async run(ctx) {
    const to = strParam(ctx, 'to', '');
    if (!to) throw new Error('需要 --param to=<你已验证的邮箱>');
    const res = await ctx.client.post('/api/lab/email/compare', { route: '/api/lab/email/compare', json: { to }, expect: [200, 400, 404, 501] });
    if (res.status !== 200) {
      ctx.note(`POST /api/lab/email/compare 返回 ${res.status}${res.status === 400 ? `：${res.text().slice(0, 200)}` : '（端点尚未登记或未实现）'}`);
      return;
    }
    const r = res.json<{ to?: string; reserved?: boolean; outbox?: Run; ses?: Run }>();
    ctx.finding('to', r.to);
    ctx.finding('reserved', r.reserved);
    ctx.finding('outbox', r.outbox);
    ctx.finding('ses', r.ses);
    ctx.business('compare_outbox_ms', r.outbox?.ms);
    if (r.ses && !r.ses.skipped) {
      ctx.business('compare_ses_ms', r.ses.ms);
      ctx.business('compare_ses_delivered', r.ses.delivered ? 1 : 0);
    }
  },
});

// 直接运行时转交给运行器（npm run exp -- email --label after --scenario compare …）
const invokedDirectly = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const { runExperiment, parseRunnerArgs } = await import('../_lib/runner.js');
  const label = process.argv.includes('--label') ? [] : ['--label', 'after'];
  const r = await runExperiment(parseRunnerArgs(['email', '--scenario', 'compare', ...label, ...process.argv.slice(2)]));
  process.exit(r.code);
}
