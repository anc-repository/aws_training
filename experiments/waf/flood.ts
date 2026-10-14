/**
 * waf/flood —— 限速对比（01#waf 第 5 节步骤 1）。短轮次：rate 略高于速率规则阈值，duration 以秒计（PM-M05），不做洪泛式压测。
 *
 *   npm run exp -- waf --label before --scenario flood --param target=direct     # 纯 Nginx（WAF_MODE=nginx）
 *   npm run exp -- waf --label after  --scenario flood --param target=edge       # AWS WAF（挂在 CloudFront 上）
 *   npm run exp -- waf --label after  --scenario flood --param target=both       # 两条路径同一套攻击（运行时 A/B）
 *
 * 从单个“IP”以固定速率 rate 持续 duration 秒，逐秒记录状态码；关键指标：到第一次被拦截的时间（time-to-first-block）、
 * 拦截比例、源站实际收到的请求数（服务端证据 /api/lab/waf/origin 的 nonce 计数——被 AWS WAF 在边缘拦截的请求不进源站日志）。
 * 默认打 POST /api/auth/login（匿名、坏口令 → Nginx ca_auth 2r/s 与 WAF rate-login 都会拦）。
 */
import { runRate } from '../_lib/load.js';
import { defineScenario, numParam, strParam } from '../_lib/scenario.js';
import { round3 } from '../_lib/util.js';
import { attackClient, originEvidence, runNonce, wafTargets, wafSegment, withNonce } from './lib.js';

interface PathStat { sent: number; byStatus: Record<string, number>; blocked: number; firstBlockMs?: number; wafSegs: Record<string, number> }

function stat(): PathStat {
  return { sent: 0, byStatus: {}, blocked: 0, wafSegs: {} };
}

export default defineScenario({
  warmupWithRun: false,
  async run(ctx) {
    const mode = strParam(ctx, 'target', 'both');
    const rate = Math.min(numParam(ctx, 'rate', 8), 50);                 // req/s per path; capped (no flood, 01 convention 13)
    const seconds = Math.min(numParam(ctx, 'duration', 30), 120);
    // never run longer than the runner's measurement window (--duration; keeps the smoke test fast)
    const windowMs = ctx.durationMs > 0 ? Math.min(seconds * 1000, ctx.durationMs) : seconds * 1000;
    const method = strParam(ctx, 'method', 'POST').toUpperCase() === 'GET' ? 'GET' : 'POST';
    const path = strParam(ctx, 'path', '/api/auth/login');
    const nonce = runNonce(ctx);
    const { direct, edge } = wafTargets(ctx);
    const paths: Array<['direct' | 'edge', string]> = [];
    if (mode !== 'edge') paths.push(['direct', direct]);
    if (mode !== 'direct' && edge) paths.push(['edge', edge]);
    if (mode !== 'direct' && !edge) ctx.note('CloudFront 入口未知（cdn 未启用？）：只打直连入口');
    if (!paths.length) { ctx.note('没有可用的攻击目标'); return; }

    const stats: Record<string, PathStat> = {};
    const started = ctx.elapsedMs();
    await Promise.all(paths.map(async ([target, base]) => {
      const s = stats[target] = stat();
      const client = attackClient(ctx, base, target);
      await runRate({ ratePerSec: rate, durationMs: windowMs, maxInFlight: 20, signal: ctx.signal }, async () => {
        const body = method === 'POST' ? { email: `flood-${Math.random().toString(36).slice(2, 8)}@invalid.test`, password: 'x' } : undefined;
        const res = await client.request(method, withNonce(path, nonce), { route: path, expect: [200, 400, 401, 403, 429], ...(body ? { json: body } : {}) });
        s.sent += 1;
        s.byStatus[String(res.status)] = (s.byStatus[String(res.status)] ?? 0) + 1;
        const seg = wafSegment(res);
        if (seg) s.wafSegs[seg] = (s.wafSegs[seg] ?? 0) + 1;
        if (res.status === 429 || res.status === 403) {
          s.blocked += 1;
          if (s.firstBlockMs === undefined) s.firstBlockMs = Math.round(ctx.elapsedMs() - started);
        }
      });
    }));

    if (ctx.phase !== 'measure') return;
    for (const [target, s] of Object.entries(stats)) {
      ctx.finding(target, {
        sent: s.sent, blocked: s.blocked, blockRatio: s.sent ? round3(s.blocked / s.sent) : 0,
        firstBlockMs: s.firstBlockMs ?? null, byStatus: s.byStatus, wafSegments: s.wafSegs,
      });
    }
    ctx.finding('params', { rate, durationSec: seconds, method, path });
    // 服务端证据：源站实际收到多少请求（AWS WAF 在边缘拦截的请求不进源站日志；Nginx 的 429 会进）
    const origin = await originEvidence(ctx.client, ctx.runId, nonce).catch(() => undefined);
    if (origin) {
      ctx.finding('origin', { logPresent: origin.logPresent, nonceCount: origin.nonce?.count ?? 0, noncePorts: origin.nonce?.ports ?? [], byPort: origin.byPort });
      if (stats.edge && stats.direct) {
        const edgeReached = origin.nonce?.ports?.includes(8080) ? '部分（放行的请求回源到 8080）' : '0';
        ctx.note(`源站 nonce 计数 ${origin.nonce?.count ?? 0}：直连每个请求都到达源站并计入，经 WAF 拦截的请求不到达（${edgeReached}）`);
      }
    } else {
      ctx.note('/api/lab/waf/origin 不可用（集成阶段登记后可用）：只有客户端看到的状态码');
    }
  },
});
