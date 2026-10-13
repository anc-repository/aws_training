/**
 * queue/upload-burst —— 上传突发（04#queue 第 5 节步骤 1～3、5）。
 *
 *   npm run exp -- queue --label l0     --scenario upload-burst --vus 10 --duration 60s
 *   npm run exp -- queue --label before --scenario upload-burst     # memory + worker，第 30 秒 faults/restart-api.sh
 *   npm run exp -- queue --label after  --scenario upload-burst     # sqs + worker，第 30 秒 faults/kill-worker.sh
 *   npm run exp -- queue --label after  --scenario upload-burst --ab
 *
 * 上传 count 张小图（默认 200），记录 complete 的延迟，然后轮询直到全部 READY；超过排空时限仍未就绪的计入 jobsLost
 * （memory 档重启 api 后，这些照片要等对账任务分钟级找回，就绪时间会被显著拉长）。
 */
import { defineScenario, numParam } from '../_lib/scenario.js';
import { runUploadBurst } from '../_lib/scenarios/upload-burst.js';

export default defineScenario({
  async run(ctx) {
    const { uploads, ready } = await runUploadBurst(ctx, {
      width: numParam(ctx, 'width', 1600),
      height: numParam(ctx, 'height', 1200),
      count: ctx.phase === 'warmup' ? Math.min(5, numParam(ctx, 'count', 200)) : numParam(ctx, 'count', 200),
      abComplete: true,
      drainTimeoutMs: numParam(ctx, 'drainTimeoutSec', 600) * 1000,
    });
    if (ctx.phase !== 'measure') return;
    const modes: Record<string, number> = {};
    for (const u of uploads) modes[String(u.completeStatus)] = (modes[String(u.completeStatus)] ?? 0) + 1;
    ctx.finding('completeStatus', modes);
    ctx.finding('notReady', ready.filter((r) => r.status !== 'READY').map((r) => ({ id: r.id, status: r.status })).slice(0, 20));
  },
});
