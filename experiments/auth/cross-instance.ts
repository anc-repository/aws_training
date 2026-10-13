/**
 * auth/cross-instance —— 跨实例认证（02#auth 第 5 节步骤 6；autoscaling 启用时有意义）。
 *
 *   npm run exp -- auth --label before --scenario cross-instance --target https://<ALB 或 CDN 域名> --param n=200
 *
 * 用同一个令牌经负载均衡反复请求 GET /api/me，按响应路径头的 `inst=` 段统计各实例的成功 / 失败次数。
 * local 档需要共享签名密钥（SECRETS_ORIGIN=bundle|aws）与共享数据库，否则在 A 实例签发的令牌到 B 实例会失败。
 */
import { ROUTES } from '../_lib/app.js';
import { runVus } from '../_lib/load.js';
import { defineScenario, numParam } from '../_lib/scenario.js';
import { round3 } from '../_lib/util.js';

export default defineScenario({
  warmupWithRun: false,
  async run(ctx) {
    const n = numParam(ctx, 'n', 200);
    const perInstance: Record<string, { ok: number; fail: number }> = {};
    let ok = 0;
    let total = 0;
    await runVus({ vus: ctx.vus, durationMs: ctx.durationMs, iterations: n, signal: ctx.signal }, async () => {
      const res = await ctx.client.get(ROUTES.me, { route: ROUTES.me, expect: [200] });
      const inst = res.path.inst ?? res.path.modules.find((m) => m.module === 'load-balancer')?.raw ?? 'unknown';
      const b = perInstance[inst] ?? (perInstance[inst] = { ok: 0, fail: 0 });
      total += 1;
      if (res.ok) {
        ok += 1;
        b.ok += 1;
      } else {
        b.fail += 1;
      }
    });
    ctx.finding('perInstance', perInstance);
    ctx.finding('instanceCount', Object.keys(perInstance).length);
    ctx.finding('successRate', total ? round3(ok / total) : undefined);
    if (Object.keys(perInstance).length < 2) ctx.note('只观察到一个实例：需要经 ALB 访问 ASG（或本机 LB_LOCAL_WORKERS=2）才能看出跨实例差异');
  },
});
