/**
 * image-processing/neighbor —— 邻居影响（04#image-processing 第 5 节步骤 2）。
 *
 *   npm run exp -- image-processing --label before --scenario neighbor
 *   npm run exp -- image-processing --label after  --scenario neighbor
 *
 * 与 upload-burst 相同的上传负载，同时以 feedRps（默认 5）次 / 秒开环读取 `GET /api/feed`；报告重点看 feed 的 p95 / p99
 * （inline 下 sharp 占满事件循环与 CPU，浏览接口一起变慢）。两部分请求在同一个 runId 下，客户端按路由分开统计。
 */
import { ROUTES } from '../_lib/app.js';
import { defineScenario, numParam } from '../_lib/scenario.js';
import { runUploadBurst } from '../_lib/scenarios/upload-burst.js';
import { percentile, round1 } from '../_lib/util.js';

export default defineScenario({
  async run(ctx) {
    const start = ctx.recorder.size;
    await runUploadBurst(ctx, {
      width: numParam(ctx, 'width', 4000),
      height: numParam(ctx, 'height', 3000),
      ...(ctx.phase === 'warmup' ? { count: Math.max(1, Math.min(ctx.vus, 4)) } : {}),
      feedRps: numParam(ctx, 'feedRps', 5),
      drainTimeoutMs: numParam(ctx, 'drainTimeoutSec', 300) * 1000,
    });
    if (ctx.phase !== 'measure') return;
    const feed = ctx.recorder.all().slice(start).filter((s) => s.route === ROUTES.feed);
    const d = feed.map((s) => s.totalMs);
    ctx.finding('feedUnderLoad', { requests: feed.length, errors: feed.filter((s) => !s.ok).length, p95: round1(percentile(d, 95)), p99: round1(percentile(d, 99)) });
  },
});
