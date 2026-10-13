/**
 * cdn/origin-requests —— 源站请求统计（01#cdn 第 5 节步骤 3 末尾）。
 *
 *   npm run exp -- cdn --label after --scenario origin-requests [--param windowMin=15]
 *
 * 读取 `/api/lab/metrics?from=<windowMin 分钟前>` 的源站卸载采样（worker 增量读 Nginx JSON 访问日志，按 cf_id / alb_trace
 * 是否为空分类），汇总“经 CloudFront / 经 ALB / 直连”的请求数与字节数。不发负载，通常在 media-load 之后运行。
 */
import { summarizeOrigin } from '../_lib/collect.js';
import { defineScenario, numParam } from '../_lib/scenario.js';
import { round3 } from '../_lib/util.js';

export default defineScenario({
  warmupWithRun: false,
  async run(ctx) {
    const windowMin = numParam(ctx, 'windowMin', 15);
    const from = new Date(Date.now() - windowMin * 60_000).toISOString();
    const res = await ctx.client.get(`/api/lab/metrics?from=${encodeURIComponent(from)}&groupBy=route`, { route: '/api/lab/metrics', record: false });
    if (!res.ok) {
      ctx.note(`/api/lab/metrics 不可用（${res.status}）`);
      return;
    }
    const body = res.json<{ origin?: Array<Record<string, unknown>> }>();
    const o = summarizeOrigin(body.origin);
    ctx.finding('windowMin', windowMin);
    if (!o) {
      ctx.note('窗口内没有源站采样（worker 未运行，或 Nginx JSON 访问日志尚未被读取）');
      ctx.finding('samples', 0);
      return;
    }
    ctx.finding('samples', o.samples);
    ctx.finding('requests', o.requests);
    ctx.finding('bytes', o.bytes);
    ctx.finding('viaCloudfront', o.viaCloudfront);
    ctx.finding('viaAlb', o.viaAlb);
    ctx.finding('direct', o.direct);
    ctx.finding('cloudfrontShare', o.requests ? round3(o.viaCloudfront / o.requests) : undefined);
  },
});
