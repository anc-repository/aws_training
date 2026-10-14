/**
 * logging/ingest-lag —— 摄取延迟（05#logging 第 5 节步骤 1）。
 *
 *   npm run exp -- logging --label after --scenario ingest-lag --upload [--param requests=20 --param timeoutSec=120]
 *
 * 1. 发送 N 个带实验头的 `GET /api/lab/now`（管理员），从响应头 X-CloudAlbum-Request-Id 取每个请求的 ID（Nginx 的 $request_id，
 *    与访问日志的 rid 字段相同；客户端传入的 X-Request-Id 不会被沿用）。
 * 2. 立刻在本地一侧查一次（store=local，Nginx 访问日志按 run ID 过滤）：本地文件“立即可见”。
 * 3. 每 2 秒查一次 CloudWatch 一侧（store=cloudwatch&source=nginx&q=<runId>，FilterLogEvents），直到全部 rid 出现或超时。
 * 服务端证据：每行的 ingestedAt − eventTs（CloudWatch 的 ingestionTime − 事件时间；事件时间取 Nginx 行的 ts，秒级精度）——
 * 这是“请求完成 → CloudWatch 收下”的延迟，与客户端轮询间隔无关；客户端另记“请求完成 → 第一次查到”的可见延迟作为对照。
 */
import { HEADERS } from '@cloudalbum/contracts';
import { defineScenario, numParam } from '../_lib/scenario.js';
import { median, round1, sleep } from '../_lib/util.js';
import { LogsApiError, queryLogs, type LogRow } from './logs-api.js';

export default defineScenario({
  warmupWithRun: false,
  async run(ctx) {
    const n = numParam(ctx, 'requests', 20);
    const timeoutMs = numParam(ctx, 'timeoutSec', 120) * 1000;
    const t0 = Date.now();
    const sent = new Map<string, number>();                          // rid → 请求完成时刻（客户端时钟）
    for (let i = 0; i < n && !ctx.signal.aborted; i += 1) {
      const res = await ctx.client.get('/api/lab/now', { route: '/api/lab/now' });
      const rid = res.headers[HEADERS.requestId.toLowerCase()];
      if (rid) sent.set(rid, Date.now());
      await sleep(200, ctx.signal);
    }
    ctx.finding('requests', sent.size);
    if (!sent.size) {
      ctx.note('响应头里没有 X-CloudAlbum-Request-Id：请求没有经过 Nginx（EXP_TARGET 应该是实例的 http://<EIP>）');
      return;
    }
    const from = new Date(t0 - 60_000).toISOString();

    // 本地一侧：立即可见（服务端证据：实例上的扫描结果）
    try {
      const local = await queryLogs(ctx, { store: 'local', source: 'nginx', q: ctx.runId, from, limit: 1000 });
      const seen = new Set((local.rows ?? []).map((r) => r.requestId));
      ctx.finding('local', { foundImmediately: [...sent.keys()].filter((r) => seen.has(r)).length, tookMs: local.meta?.tookMs });
    } catch (e) {
      ctx.note(`本地一侧查询失败：${(e as Error).message}`);
    }

    // CloudWatch 一侧：轮询直到全部出现
    const firstSeen = new Map<string, LogRow & { seenAt: number }>();
    const deadline = Date.now() + timeoutMs;
    let polls = 0;
    while (firstSeen.size < sent.size && Date.now() < deadline && !ctx.signal.aborted) {
      polls += 1;
      try {
        const r = await queryLogs(ctx, { store: 'cloudwatch', source: 'nginx', q: ctx.runId, from, to: new Date(Date.now() + 60_000).toISOString(), limit: 1000 });
        const now = Date.now();
        for (const row of r.rows ?? []) {
          if (row.requestId && sent.has(row.requestId) && !firstSeen.has(row.requestId)) firstSeen.set(row.requestId, { ...row, seenAt: now });
        }
      } catch (e) {
        if (e instanceof LogsApiError && (e.status === 404 || e.status === 409)) {
          ctx.note(`CloudWatch 一侧不可用：${e.message}`);
          ctx.finding('cloudwatchAvailable', false);
          return;
        }
        ctx.log(`查询失败（继续轮询）：${(e as Error).message}`);
      }
      if (firstSeen.size < sent.size) await sleep(2000, ctx.signal);
    }
    const server: number[] = [];
    const visible: number[] = [];
    const instances = new Set<string>();
    for (const [rid, row] of firstSeen) {
      if (row.eventTs && row.ingestedAt) server.push(Date.parse(row.ingestedAt) - Date.parse(row.eventTs));
      visible.push(row.seenAt - (sent.get(rid) ?? row.seenAt));
      if (row.instanceId) instances.add(row.instanceId);
    }
    ctx.finding('cloudwatchAvailable', true);
    ctx.finding('found', firstSeen.size);
    ctx.finding('missing', sent.size - firstSeen.size);
    ctx.finding('polls', polls);
    ctx.finding('ingestLagP50Ms', round1(median(server)));
    ctx.finding('ingestLagMaxMs', server.length ? Math.max(...server) : undefined);
    ctx.finding('visibleP50Ms', round1(median(visible)));
    ctx.finding('visibleMaxMs', visible.length ? Math.max(...visible) : undefined);
    ctx.finding('instances', instances.size);
    ctx.finding('shipper', (ctx.capabilities.modules.logging?.data as { shipper?: string } | undefined)?.shipper);
    ctx.business('ingest_lag_p50_ms', median(server));
    if (firstSeen.size < sent.size) ctx.note(`${sent.size - firstSeen.size} 个请求在 ${timeoutMs / 1000} 秒内没有出现在 CloudWatch 中（发送积压？看 /lab 的 logging 卡片）`);
  },
});
