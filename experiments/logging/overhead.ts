/**
 * logging/overhead —— 发送器开销（05#logging 第 5 节步骤 5）。
 *
 *   npm run exp -- logging --label before --scenario overhead --upload    # LOG_DRIVER=file
 *   npm run exp -- logging --label after  --scenario overhead --upload    # LOG_DRIVER=cloudwatch（sdk 方式）
 *
 * 恒定负载（vus 个 VU 循环 `GET /api/lab/now` 与 `GET /api/health/ready`），比较切换前后服务端的主机采样：api 进程的 CPU p95
 * 与事件循环延迟 p99（运行器结束后从 /api/lab/metrics?run=<runId> 拉取，服务端证据）。agent 方式的开销在 Agent 进程上，
 * 用 `top -p $(pgrep -f amazon-cloudwatch-agent)` 另看（README）。
 */
import { runVus } from '../_lib/load.js';
import { defineScenario, numParam } from '../_lib/scenario.js';

export default defineScenario({
  async run(ctx) {
    const vus = numParam(ctx, 'vus', 4);
    const stats = await runVus({ vus, durationMs: ctx.durationMs, signal: ctx.signal }, async (_vu, it) => {
      await ctx.client.get(it % 2 ? '/api/lab/now' : '/api/health/ready', { route: it % 2 ? '/api/lab/now' : '/api/health/ready' });
    });
    if (ctx.phase === 'measure') {
      ctx.finding('iterations', stats.iterations);
      ctx.finding('shipper', (ctx.capabilities.modules.logging?.data as { shipper?: string } | undefined)?.shipper ?? 'file');
    }
  },
});
