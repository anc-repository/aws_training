/**
 * cache/cache-stampede —— 缓存击穿（03#cache 第 5 节步骤 6）。
 *
 * 每轮：新建一个私有相册（albums 路由随即 `cache.del` 相册列表键 = 热门键刚失效）→ 同一瞬间并发 `burst` 个
 * `GET /api/albums` → 从 Server-Timing 汇总这一批请求的 database 调用总数。none 档每个请求都查库；
 * 有缓存时 single-flight 让每个进程只回源一次（多实例时每个实例各一次）。结束后删除新建的相册。
 */
import { ROUTES } from '../_lib/app.js';
import { defineScenario, numParam } from '../_lib/scenario.js';
import { callsPerRequest, outcomeCounts } from '../_lib/scenarios/feed-read.js';
import { mean, percentile, round1, sleep } from '../_lib/util.js';

export default defineScenario({
  warmupWithRun: false,
  async run(ctx) {
    const rounds = numParam(ctx, 'rounds', 5);
    const burst = numParam(ctx, 'burst', 50);
    const pauseMs = numParam(ctx, 'pauseMs', 1000);
    const perRound: Array<Record<string, unknown>> = [];
    const dbCalls: number[] = [];
    for (let r = 1; r <= rounds && !ctx.signal.aborted; r += 1) {
      if (r > 1 && ctx.remainingMs() <= 0) {
        ctx.note(`时长用尽，只完成了 ${r - 1}/${rounds} 轮`);
        break;
      }
      const created = await ctx.client.post(ROUTES.albums, {
        route: ROUTES.albums, json: { title: `stampede ${ctx.runId.slice(-6)} #${r}`, visibility: 'private' },
      });
      if (created.ok) {
        const id = created.json<{ id?: string }>().id;
        if (id) ctx.cleanupLater('DELETE', `/api/albums/${id}`);
      } else {
        ctx.log(`第 ${r} 轮新建相册失败（${created.status}）：键可能没有失效`);
      }
      const start = ctx.recorder.size;
      await Promise.all(Array.from({ length: burst }, () => ctx.client.get(ROUTES.albums, { route: ROUTES.albums })));
      const samples = ctx.recorder.all().slice(start).filter((s) => s.method === 'GET' && s.route === ROUTES.albums);
      const perReq = callsPerRequest(samples, 'database') ?? 0;
      const total = Math.round(perReq * samples.length);
      dbCalls.push(total);
      perRound.push({
        round: r, requests: samples.length, dbCalls: total, cache: outcomeCounts(samples, 'cache'),
        p95: round1(percentile(samples.map((s) => s.totalMs), 95)), errors: samples.filter((s) => !s.ok).length,
      });
      await sleep(pauseMs, ctx.signal);
    }
    ctx.finding('burst', burst);
    ctx.finding('rounds', perRound);
    ctx.finding('dbCallsPerBurst', round1(mean(dbCalls)));
    ctx.finding('dbCallsPerBurstMax', dbCalls.length ? Math.max(...dbCalls) : undefined);
    ctx.finding('instances', Object.keys(ctx.recorder.summary().instances ?? {}).length || 1);
  },
});
