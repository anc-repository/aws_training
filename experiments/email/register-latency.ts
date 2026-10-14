/**
 * email/register-latency —— 同步链路的代价（04#email 第 5 节步骤 7；卡片 svc-email 的选做步骤）。
 *
 *   npm run exp -- email --label before --scenario register-latency     # email=outbox
 *   npm run exp -- email --label after  --scenario register-latency     # email=ses
 *
 * 注册 count 个新用户：地址是 SES 邮箱模拟器带标签的 success+reg-<runId>-<n>@simulator.amazonses.com（沙盒中也能发，不损害信誉），
 * 验证邮件经 EmailPort 发出。auth=local 的注册在请求内直接调用 EmailPort（与 QUEUE_DRIVER 无关），所以注册接口的延迟里包含
 * 一次 outbox 写文件（毫秒级）或一次 SES SendEmail（几十到上百毫秒量级）。记录注册接口的延迟分布与 Server-Timing 的 email 段。
 * 文档原写法是 k6 脚本 register.k6.js；本仓库的运行器是 Node 实现（不依赖 k6），这里用同样的请求序列。
 * 注册接口限速：每个客户端 IP 10 分钟 20 次，count 默认 10。创建的测试用户不会被删除。
 */
import { randomBytes } from 'node:crypto';
import { defineScenario, numParam } from '../_lib/scenario.js';
import { percentile, round1 } from '../_lib/util.js';

export default defineScenario({
  warmupWithRun: false,
  async run(ctx) {
    const count = numParam(ctx, 'count', 10);
    const tag = ctx.runId.slice(-8).toLowerCase();
    const total: number[] = [];
    const email: number[] = [];
    let limited = 0;
    for (let i = 1; i <= count && !ctx.signal.aborted && ctx.remainingMs() > 0; i += 1) {
      const res = await ctx.client.post('/api/auth/register', {
        route: '/api/auth/register', auth: false, expect: [201, 409, 429],
        json: { email: `success+reg-${tag}-${i}@simulator.amazonses.com`, password: `Rl-${randomBytes(9).toString('base64url')}-3k`, displayName: `reg${i}` },
      });
      if (res.status === 429) {
        limited += 1;
        break;
      }
      if (res.status !== 201) continue;
      total.push(res.totalMs);
      const e = res.serverTiming.find((m) => m.name === 'email')?.dur;
      if (e !== undefined) email.push(e);
    }
    ctx.finding('driver', ctx.capabilities.modules?.email?.driver);
    ctx.finding('registered', total.length);
    ctx.finding('rateLimited', limited > 0);
    ctx.finding('registerMsP50', round1(percentile(total, 50)));
    ctx.finding('registerMsP95', round1(percentile(total, 95)));
    ctx.finding('emailMsP50', round1(percentile(email, 50)));
    ctx.business('register_email_ms_p50', percentile(email, 50));
    ctx.business('register_ms_p95', percentile(total, 95));
  },
});
