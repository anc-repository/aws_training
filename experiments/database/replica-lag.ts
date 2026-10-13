/**
 * database/replica-lag —— 复制滞后（03#database 第 5 节步骤 6 后半）。
 *
 *   npm run exp -- database --label after --scenario replica-lag
 *
 * 反复调用 `POST /api/lab/db/read-after-write`（仅管理员：主库写入一行后立即从副本读），统计“读不到”的比例与滞后。
 * 响应约定 `{ visible: boolean, lagMs?: number }`；端点由 database 模块实现，不存在（404 / 501）时记录并结束。
 */
import { runVus } from '../_lib/load.js';
import { defineScenario, numParam } from '../_lib/scenario.js';
import { percentile, round1, round3, sleep } from '../_lib/util.js';

const ENDPOINT = '/api/lab/db/read-after-write';

export default defineScenario({
  warmupWithRun: false,
  async run(ctx) {
    const intervalMs = numParam(ctx, 'intervalMs', 200);
    const probe = await ctx.client.post(ENDPOINT, { route: ENDPOINT, json: {}, record: false });
    if (probe.status === 404 || probe.status === 501) {
      ctx.note(`${ENDPOINT} 不可用（${probe.status}）：复制滞后端点尚未实现`);
      ctx.finding('endpointAvailable', false);
      return;
    }
    let total = 0;
    let notVisible = 0;
    const lags: number[] = [];
    await runVus({ vus: ctx.vus, durationMs: ctx.durationMs, signal: ctx.signal }, async () => {
      const r = await ctx.client.post(ENDPOINT, { route: ENDPOINT, json: {} });
      if (r.ok) {
        total += 1;
        const b = r.json<{ visible?: boolean; lagMs?: number }>();
        if (b.visible === false) notVisible += 1;
        if (typeof b.lagMs === 'number') lags.push(b.lagMs);
      }
      await sleep(intervalMs, ctx.signal);
    });
    ctx.finding('endpointAvailable', true);
    ctx.finding('samples', total);
    ctx.finding('notVisibleRatio', total ? round3(notVisible / total) : undefined);
    ctx.finding('lagMsP95', round1(percentile(lags, 95)));
  },
});
