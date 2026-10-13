/**
 * cache/stale-read —— 写后陈旧读（03#cache 第 5 节步骤 5）。
 *
 * 先读几次时间线预热缓存 → 上传一张小图并等它 READY（写入）→ 每 intervalMs 读一次 `GET /api/feed?scope=mine`，持续一个 TTL，
 * 统计“返回的时间线里还没有这张照片”的比例与最长陈旧时间。路径头的 `load-balancer=nginx:w3000|w3001` 段或 `inst=` 段
 * 标出是哪个进程 / 实例返回的旧数据。结束后删除这张照片。
 */
import { ROUTES, uploadPhoto, waitReady, type PhotoDto } from '../_lib/app.js';
import { testJpeg } from '../_lib/images.js';
import { defineScenario, numParam } from '../_lib/scenario.js';
import { round3, sleep } from '../_lib/util.js';

export default defineScenario({
  warmupWithRun: false,
  async run(ctx) {
    const ttlMs = numParam(ctx, 'ttlSec', 60) * 1000;
    const intervalMs = numParam(ctx, 'intervalMs', 500);
    const feedPath = `${ROUTES.feed}?scope=mine&limit=24`;
    for (let i = 0; i < 6; i += 1) await ctx.client.get(feedPath, { route: ROUTES.feed, record: false });

    const image = await testJpeg({ width: 320, height: 240 });
    const up = await uploadPhoto(ctx, { image, title: `stale-read ${ctx.runId.slice(-6)}` });
    if (up.error) {
      ctx.note(`上传失败，无法测量：${up.error}`);
      return;
    }
    const [ready] = await waitReady(ctx, [up], { timeoutMs: 120_000, intervalMs: 300 });
    if (ready?.status !== 'READY') {
      ctx.note(`照片没有在 120 秒内就绪（${ready?.status}），无法测量`);
      return;
    }
    const writtenAt = Date.now();
    const pollUntil = writtenAt + Math.min(ttlMs + 2000, Math.max(ctx.remainingMs(), 5000));
    let responses = 0;
    let stale = 0;
    let lastStaleAt: number | undefined;
    const byWorker: Record<string, { responses: number; stale: number }> = {};
    while (Date.now() < pollUntil && !ctx.signal.aborted) {
      const res = await ctx.client.get(feedPath, { route: ROUTES.feed });
      if (res.ok) {
        responses += 1;
        const items = res.json<{ items?: PhotoDto[] }>().items ?? [];
        const isStale = !items.some((p) => p.id === up.id);
        const lb = res.path.modules.find((m) => m.module === 'load-balancer')?.raw;
        const worker = lb ?? res.path.inst ?? 'single';
        const w = byWorker[worker] ?? (byWorker[worker] = { responses: 0, stale: 0 });
        w.responses += 1;
        if (isStale) {
          stale += 1;
          w.stale += 1;
          lastStaleAt = Date.now();
        }
      }
      await sleep(intervalMs, ctx.signal);
    }
    ctx.finding('responses', responses);
    ctx.finding('staleResponses', stale);
    ctx.finding('staleRatio', responses ? round3(stale / responses) : undefined);
    ctx.finding('longestStaleMs', lastStaleAt ? lastStaleAt - writtenAt : 0);
    ctx.finding('byWorker', byWorker);
    ctx.finding('ttlSec', ttlMs / 1000);
    if (Object.keys(byWorker).length < 2) ctx.note('只观察到一个进程 / 实例：memory 档的不一致需要 LB_LOCAL_WORKERS=2 或多实例才会出现');
  },
});
