/**
 * database/mixed-rw —— 混合读写（03#database 第 5 节步骤 2）。
 *
 *   npm run exp -- database --label before   --scenario mixed-rw --vus 10,50,200
 *   npm run exp -- database --label selfhost --scenario mixed-rw --vus 10,50,200
 *   npm run exp -- database --label after    --scenario mixed-rw --vus 10,50,200
 *   npm run exp:report -- database --experiment mixed-rw
 *
 * writeRatio（默认 0.3）的请求是写：其中 commentShare 发评论（`POST /social/photos/:id/comments`，社交写接口按用户限速，
 * 429 单独计数、不算错误），其余建私有相册（`POST /api/albums`，结束后删除）；其余请求读时间线。
 * 事件循环延迟 P99 来自主机采样（host.event_loop_delay.p99），每请求 DB 调用次数与耗时来自 Server-Timing 的 database 项。
 */
import { ensureTargetPhoto, ROUTES } from '../_lib/app.js';
import { testJpeg } from '../_lib/images.js';
import { runVus } from '../_lib/load.js';
import { defineScenario, numParam } from '../_lib/scenario.js';

export default defineScenario({
  async run(ctx) {
    const writeRatio = numParam(ctx, 'writeRatio', 0.3);
    const commentShare = numParam(ctx, 'commentShare', 0.25);
    const photoId = await ensureTargetPhoto(ctx, await testJpeg({ width: 320, height: 240 }));
    if (!photoId) ctx.note('没有可评论的照片（上传失败？）：写请求全部改为建相册');
    let reads = 0;
    let comments = 0;
    let albums = 0;
    let rateLimited = 0;
    await runVus({ vus: ctx.vus, durationMs: ctx.durationMs, signal: ctx.signal }, async (vu, it) => {
      if (Math.random() >= writeRatio) {
        reads += 1;
        await ctx.client.get(`${ROUTES.feed}?scope=mine&limit=24`, { route: ROUTES.feed });
        return;
      }
      if (photoId && Math.random() < commentShare) {
        comments += 1;
        const r = await ctx.client.post(`/social/photos/${photoId}/comments`, {
          route: ROUTES.comments, json: { text: `mixed-rw ${ctx.runId.slice(-6)} vu${vu} #${it}` }, expect: [201, 429],
        });
        if (r.status === 429) rateLimited += 1;
        return;
      }
      albums += 1;
      const r = await ctx.client.post(ROUTES.albums, { route: ROUTES.albums, json: { title: `mixed-rw ${ctx.runId.slice(-6)} ${vu}-${it}`, visibility: 'private' } });
      if (r.ok) {
        const id = r.json<{ id?: string }>().id;
        if (id) ctx.cleanupLater('DELETE', `/api/albums/${id}`);
      }
    });
    if (ctx.phase !== 'measure') return;
    ctx.finding(ctx.stage ? `ops:${ctx.stage}` : 'ops', { reads, comments, albums, commentRateLimited: rateLimited });
    ctx.finding('engine', ctx.capabilities.modules.database?.driver ?? 'unknown');
  },
});
