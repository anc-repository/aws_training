/**
 * cdn/ttfb —— 跨地域首字节时间（01#cdn 第 5 节步骤 2）。
 *
 *   npm run exp -- cdn --label after --scenario ttfb --upload        # 在四个区域的 CloudShell 各跑一次
 *   npm run exp -- cdn --label before --scenario ttfb                # 只有直连一条路径
 *
 * 对直连 URL 与 CDN URL 各请求 samples 次，每次新建连接（等价于 curl 的 time_connect / time_appconnect / time_starttransfer），
 * 记录 X-Cache（Hit / Miss / RefreshHit）、X-Amz-Cf-Pop、Age 与 Server-Timing 的 cdn-* 项。结果写在 client.byTarget 与 findings。
 */
import { cdnPop, recordProbe, timedGet, type ProbeResult } from '../_lib/probe.js';
import { defineScenario, numParam, strParam } from '../_lib/scenario.js';
import { percentile, round1, round3 } from '../_lib/util.js';
import { assetPaths, cdnTargets } from './targets.js';

function summarize(rs: readonly ProbeResult[]): Record<string, unknown> {
  const pick = (f: (r: ProbeResult) => number | undefined) => rs.map(f).filter((v): v is number => v !== undefined);
  const xCache: Record<string, number> = {};
  const pops: Record<string, number> = {};
  for (const r of rs) {
    const x = r.headers['x-cache']?.split(' ')[0]?.toLowerCase();
    if (x) xCache[x] = (xCache[x] ?? 0) + 1;
    const p = cdnPop(r);
    if (p) pops[p] = (pops[p] ?? 0) + 1;
  }
  const hits = Object.entries(xCache).filter(([k]) => k.includes('hit')).reduce((a, [, n]) => a + n, 0);
  return {
    samples: rs.length,
    errors: rs.filter((r) => r.error || r.status >= 400 || r.status === 0).length,
    ttfbP50: round1(percentile(pick((r) => r.ttfbMs), 50)),
    ttfbP95: round1(percentile(pick((r) => r.ttfbMs), 95)),
    connectP50: round1(percentile(pick((r) => r.connectMs), 50)),
    tlsP50: round1(percentile(pick((r) => r.tlsMs), 50)),
    totalP50: round1(percentile(pick((r) => r.totalMs), 50)),
    xCache, pops,
    hitRatio: rs.length && Object.keys(xCache).length ? round3(hits / rs.length) : undefined,
    age: rs.map((r) => r.headers.age).filter(Boolean).slice(-3),
    httpVersion: rs[0]?.httpVersion,
  };
}

export default defineScenario({
  warmupWithRun: false,
  async run(ctx) {
    const { direct, cdn } = cdnTargets(ctx);
    const samples = numParam(ctx, 'samples', 20);
    let resource = strParam(ctx, 'path', '');
    if (!resource) {
      const index = await ctx.client.get(`${direct}/`, { record: false, auth: false });
      resource = index.ok ? assetPaths(index.text()).js ?? '/' : '/api/health/live';
    }
    ctx.finding('resource', resource);
    ctx.finding('targets', { direct, ...(cdn ? { cdn } : {}) });
    if (!cdn) ctx.note('没有 CDN 基址（cdn 未启用或 capabilities 未给出 baseUrl）：只测直连路径；可用 --param cdn=https://dxxxx.cloudfront.net 指定');
    const results: Record<string, ProbeResult[]> = { direct: [], ...(cdn ? { cdn: [] } : {}) };
    for (let i = 0; i < samples && !ctx.signal.aborted; i += 1) {
      for (const [target, base] of Object.entries({ direct, ...(cdn ? { cdn } : {}) })) {
        const r = await timedGet(`${base}${resource}`);
        recordProbe(ctx.recorder, r, target, resource);
        results[target]!.push(r);
      }
    }
    const d = summarize(results.direct!);
    ctx.finding('direct', d);
    if (cdn) {
      const c = summarize(results.cdn!);
      ctx.finding('cdn', c);
      const ratio = typeof c.ttfbP50 === 'number' && typeof d.ttfbP50 === 'number' && d.ttfbP50 > 0 ? round3(c.ttfbP50 / d.ttfbP50) : undefined;
      ctx.finding('cdnVsDirectTtfbRatio', ratio);
    }
    ctx.finding('clientRegion', process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'local');
  },
});
