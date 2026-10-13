/**
 * database/replica-read —— 只读副本的运行时 A/B（03#database 第 5 节步骤 6）。
 *
 *   npm run exp -- database --label after --scenario replica-read --ab
 *   npm run exp:report -- database --experiment replica-read --pair after:A,after:B
 *
 * GET /api/feed 交替带 / 不带 `X-Compare-Bypass: replica`：A 走主库，B 走副本（路径头 database=postgres@rds:replica）。
 * 比较两者的 p95 与 database 段耗时；主库 CPU 用 CloudWatch 旁证。
 */
import { defineScenario } from '../_lib/scenario.js';
import { runFeedRead } from '../_lib/scenarios/feed-read.js';

export default defineScenario({
  async run(ctx) {
    if (!ctx.ab && ctx.phase === 'measure') ctx.note('没有加 --ab：所有请求都走正常路径（副本），没有对照组');
    await runFeedRead(ctx, { scope: 'mine', limit: 24 });
  },
});
