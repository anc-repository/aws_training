/**
 * cache/feed-read —— 时间线读压测（03#cache 第 5 节步骤 2、3、7）。
 *
 *   npm run exp -- cache --label after --scenario feed-read --ab --vus 20 --duration 120s
 *   npm run exp -- cache --label before --scenario feed-read            # none / memory / selfhost / after 四档各一次
 *   npm run exp -- cache --label selfhost --scenario fail-open          # 同一脚本 + faults/stop-valkey.sh
 *
 * 发现：按变体的每请求 DB 调用次数（Server-Timing `database` 的 xN）、cache 段结果分布与命中率（排除 bypass）。
 */
import { defineScenario, numParam, strParam } from '../_lib/scenario.js';
import { runFeedRead } from '../_lib/scenarios/feed-read.js';

export default defineScenario({
  async run(ctx) {
    const scope = strParam(ctx, 'scope', 'mine') === 'public' ? 'public' : 'mine';
    await runFeedRead(ctx, { scope, limit: numParam(ctx, 'limit', 24) });
  },
});
