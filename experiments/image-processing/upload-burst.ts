/**
 * image-processing/upload-burst —— 上传突发（04#image-processing 第 5 节步骤 1、3、4、5）。
 *
 *   npm run exp -- image-processing --label before        --scenario upload-burst --vus 20 --duration 60s
 *   npm run exp -- image-processing --label worker-memory --scenario upload-burst
 *   npm run exp -- image-processing --label worker-sqs    --scenario upload-burst
 *   npm run exp -- image-processing --label after         --scenario upload-burst [--ab]
 *
 * 默认 4000×3000 的噪声 JPEG（像素数决定 sharp 成本）；走完“建档 → PUT → complete → 轮询直到 READY”。
 * 业务指标：缩略图就绪时间（readyAt − createdAt）的 p50 / p95 / max、冷启动次数（processedBy.coldStart）、jobsLost。
 */
import { defineScenario, numParam } from '../_lib/scenario.js';
import { runUploadBurst } from '../_lib/scenarios/upload-burst.js';

export default defineScenario({
  async run(ctx) {
    const count = numParam(ctx, 'count', 0);
    await runUploadBurst(ctx, {
      width: numParam(ctx, 'width', 4000),
      height: numParam(ctx, 'height', 3000),
      ...(count > 0 ? { count } : {}),
      ...(ctx.phase === 'warmup' ? { count: Math.max(1, Math.min(ctx.vus, 4)) } : {}),
      feedRps: numParam(ctx, 'feedRps', 0),
      abComplete: true,
      drainTimeoutMs: numParam(ctx, 'drainTimeoutSec', 300) * 1000,
    });
  },
});
