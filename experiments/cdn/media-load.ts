/**
 * cdn/media-load —— 源站负载（01#cdn 第 5 节步骤 3）。
 *
 *   npm run exp -- cdn --label after --scenario media-load                     # target=both：直连 / CDN 交替
 *   npm run exp -- cdn --label after --scenario media-load --param target=direct
 *   npm run exp -- cdn --label after --scenario media-load --param target=cdn
 *
 * 每次迭代：读相册 JSON（`GET /api/feed`；直连轮次带 `X-Compare-Bypass: cdn`，返回源站 URL）→ 加载 thumbs 张缩略图 +
 * 1 张展示图（媒体 URL 已签名，不带令牌）。客户端按目标（direct / cdn）分别统计；源站请求数与 EC2 出网字节见结果的
 * server.origin 与 host.net_tx_bytes（LabMetricsStore，不依赖 CloudWatch）。
 */
import { ROUTES, type PhotoDto } from '../_lib/app.js';
import { runVus } from '../_lib/load.js';
import { defineScenario, numParam, strParam } from '../_lib/scenario.js';
import { mapLimit, round3 } from '../_lib/util.js';
import { cdnTargets } from './targets.js';

export default defineScenario({
  async run(ctx) {
    const mode = strParam(ctx, 'target', 'both');
    const thumbs = numParam(ctx, 'thumbs', 30);
    const scope = strParam(ctx, 'scope', 'public');
    const { cdn } = cdnTargets(ctx);
    const cdnHost = cdn ? new URL(cdn).host : undefined;
    if (!cdn && mode !== 'direct') ctx.note('cdn 未启用：所有媒体都由源站直出');
    let n = 0;
    const media: Record<string, { requests: number; bytes: number; hits: number; misses: number }> = {};
    await runVus({ vus: ctx.vus, durationMs: ctx.durationMs, signal: ctx.signal }, async () => {
      n += 1;
      const direct = mode === 'direct' || (mode === 'both' && n % 2 === 1);
      const feed = await ctx.client.get(`${ROUTES.feed}?scope=${scope}&limit=${Math.min(100, thumbs)}`, {
        route: ROUTES.feed, ...(direct && cdn ? { bypass: ['cdn'] } : {}), target: direct ? 'direct' : 'cdn',
      });
      if (!feed.ok) return;
      const items = feed.json<{ items?: PhotoDto[] }>().items ?? [];
      const urls = items.map((p) => p.urls?.thumb).filter((u): u is string => Boolean(u)).slice(0, thumbs);
      const display = items.find((p) => p.urls?.display)?.urls?.display;
      if (display) urls.push(display);
      await mapLimit(urls, 6, async (u) => {
        const abs = new URL(u, ctx.target);
        const target = cdnHost && abs.host === cdnHost ? 'cdn' : 'direct';
        const client = ctx.http(abs.origin, { target, auth: false, experiment: false });
        const res = await client.get(abs.href, { route: /thumb/.test(abs.pathname) ? '/media/:thumb' : '/media/:display' });
        const m = media[target] ?? (media[target] = { requests: 0, bytes: 0, hits: 0, misses: 0 });
        m.requests += 1;
        m.bytes += res.body.length;
        const x = res.headers['x-cache']?.toLowerCase() ?? '';
        if (x.includes('hit')) m.hits += 1;
        else if (x.includes('miss')) m.misses += 1;
      });
    });
    if (ctx.phase !== 'measure') return;
    for (const [t, m] of Object.entries(media)) {
      ctx.finding(t, { ...m, hitRatio: m.hits + m.misses ? round3(m.hits / (m.hits + m.misses)) : undefined });
    }
    ctx.finding('iterations', n);
  },
});
