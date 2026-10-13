/**
 * cdn/api-nocache —— 动态 API 经 CDN（01#cdn 第 5 节步骤 5）。
 *
 *   npm run exp -- cdn --label after --scenario api-nocache
 *
 * 经 CDN 请求两次 `/api/lab/now`（private, no-store，带管理员令牌）：两次都应是 Miss、时间戳不同；
 * 再请求两次 `/api/public/now`（s-maxage=10，匿名）：第二次应是 Hit、时间戳相同。最后比较直连与经 CDN 访问
 * `/api/lab/now` 的首字节时间（远端区域经 CDN 通常略快：TLS 在附近边缘终止、边缘到源站复用连接）。
 * 两个 now 端点由 cdn 模块实现；不存在（404 / 501）时记录。
 */
import type { ExpResponse } from '../_lib/http.js';
import { recordProbe, timedGet } from '../_lib/probe.js';
import { defineScenario, numParam } from '../_lib/scenario.js';
import { percentile, round1 } from '../_lib/util.js';
import { cdnTargets } from './targets.js';

function stamp(r: ExpResponse): string | undefined {
  try {
    const b = r.json<{ now?: string; at?: string; ts?: string }>();
    return b?.now ?? b?.at ?? b?.ts;
  } catch {
    return undefined;
  }
}

export default defineScenario({
  warmupWithRun: false,
  async run(ctx) {
    const { direct, cdn } = cdnTargets(ctx);
    if (!cdn) {
      ctx.note('cdn 未启用：本实验需要 CloudFront 基址（--param cdn=…）');
      return;
    }
    const viaCdn = ctx.http(cdn, { target: 'cdn' });
    const anonCdn = ctx.http(cdn, { target: 'cdn', auth: false, experiment: false });
    const check = async (client: typeof viaCdn, path: string) => {
      const a = await client.get(path, { route: path });
      const b = await client.get(path, { route: path });
      const xa = a.headers['x-cache'] ?? '';
      const xb = b.headers['x-cache'] ?? '';
      return {
        available: a.status !== 404 && a.status !== 501,
        statuses: [a.status, b.status],
        xCache: [xa, xb],
        sameTimestamp: stamp(a) !== undefined && stamp(a) === stamp(b),
        cached: /hit/i.test(xb) ? 1 : 0,
        cacheControl: a.headers['cache-control'],
      };
    };
    const labNow = await check(viaCdn, '/api/lab/now');
    const publicNow = await check(anonCdn, '/api/public/now');
    ctx.finding('labNow', labNow);
    ctx.finding('publicNow', publicNow);
    if (!labNow.available) ctx.note('/api/lab/now 不可用：端点尚未实现');
    if (!publicNow.available) ctx.note('/api/public/now 不可用：端点尚未实现');

    const samples = numParam(ctx, 'samples', 5);
    const auth = ctx.client.token ? { authorization: `Bearer ${ctx.client.token}` } : undefined;
    const ttfb: Record<'direct' | 'cdn', number[]> = { direct: [], cdn: [] };
    for (let i = 0; i < samples && !ctx.signal.aborted; i += 1) {
      for (const [target, base] of [['direct', direct], ['cdn', cdn]] as const) {
        const r = await timedGet(`${base}/api/lab/now`, auth);
        recordProbe(ctx.recorder, r, target, '/api/lab/now');
        if (r.ttfbMs !== undefined) ttfb[target].push(r.ttfbMs);
      }
    }
    ctx.finding('labNowTtfb', { directP50: round1(percentile(ttfb.direct, 50)), cdnP50: round1(percentile(ttfb.cdn, 50)) });
  },
});
