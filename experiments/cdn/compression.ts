/**
 * cdn/compression —— 压缩（01#cdn 第 5 节步骤 6）。
 *
 *   npm run exp -- cdn --label after --scenario compression
 *
 * 对首页引用的主 JS、CSS 与一个 API JSON（匿名 `/api/capabilities`）带 `Accept-Encoding: gzip, deflate, br` 分别请求两条路径，
 * 记录 Content-Encoding 与传输字节（undici 不自动解压，响应体长度即编码后的字节数）。图片本身已压缩，不在此列。
 */
import { defineScenario } from '../_lib/scenario.js';
import { assetPaths, cdnTargets } from './targets.js';

export default defineScenario({
  warmupWithRun: false,
  async run(ctx) {
    const { direct, cdn } = cdnTargets(ctx);
    const bases: Array<['direct' | 'cdn', string]> = [['direct', direct], ...(cdn ? [['cdn', cdn] as ['cdn', string]] : [])];
    const totals: Record<string, number> = {};
    for (const [target, base] of bases) {
      const client = ctx.http(base, { target, auth: false, experiment: false });
      // 先取未压缩的首页解析资源路径（不计入结果）
      const index = await client.get('/', { record: false, headers: { 'accept-encoding': 'identity', accept: 'text/html' } });
      const { js, css } = index.ok ? assetPaths(index.text()) : {};
      const resources = [js, css, '/api/capabilities'].filter((p): p is string => Boolean(p));
      const rows: Array<Record<string, unknown>> = [];
      let total = 0;
      for (const p of resources) {
        const r = await client.get(p, { route: p.startsWith('/assets/') ? `/assets/:${p.endsWith('.css') ? 'css' : 'js'}` : p, headers: { 'accept-encoding': 'gzip, deflate, br' } });
        total += r.body.length;
        rows.push({ path: p, status: r.status, encoding: r.headers['content-encoding'] ?? 'identity', bytes: r.body.length, xCache: r.headers['x-cache'] ?? null });
      }
      totals[target] = total;
      ctx.finding(target, rows);
    }
    ctx.finding('totalBytes', totals);
    if (!cdn) ctx.note('cdn 未启用：只测直连路径（Nginx gzip）');
  },
});
