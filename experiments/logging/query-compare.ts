/**
 * logging/query-compare —— 同一组查询在本地与 CloudWatch 两侧并排执行（05#logging 第 5 节步骤 2）。
 *
 *   npm run exp -- logging --label before --scenario query-compare --upload     # LOG_DRIVER=file：只有本地一侧
 *   npm run exp -- logging --label after  --scenario query-compare --upload     # LOG_DRIVER=cloudwatch：两侧
 *
 * 1. 开始时经共享故障注入接口打开 error5xx（rate 0.2，120 秒；experiment.json 的 faults，需要 featureFlags['lab.faults']）。
 * 2. 恒定负载：vus 个 VU 循环 `GET /api/lab/now`（管理员、带实验头）直到测量时长用完；客户端记下 503 的个数。
 * 3. 查询 A“按路由统计 5xx”：本地 = store=local&source=nginx&level=error&q=<runId>（实例上倒序扫描，服务端给出用时与扫描字节）；
 *    CloudWatch = Logs Insights `filter run = "<runId>" and status >= 500 | stats count(*) as errors by uri`（扫描字节是计费依据）。
 *    CloudWatch 一侧先等 FilterLogEvents 看到与本地相同的 5xx 条数（摄取延迟），最多 waitSec 秒。
 * 4. 查询 B“按 requestId 查找”：取一个失败请求的 rid，两侧各查一次（FilterLogEvents 跨所有日志流）。
 * 服务端证据：两侧的计数都来自服务端（实例上的访问日志 / CloudWatch），与客户端看到的 503 个数互相印证（agree*）。
 */
import { HEADERS } from '@cloudalbum/contracts';
import { runVus } from '../_lib/load.js';
import { defineScenario, numParam } from '../_lib/scenario.js';
import { sleep } from '../_lib/util.js';
import { LogsApiError, errorsByUri, insights, queryLogs, statsByUri, sum } from './logs-api.js';

export default defineScenario({
  warmupWithRun: false,
  async run(ctx) {
    const vus = numParam(ctx, 'vus', 2);
    const waitMs = numParam(ctx, 'waitSec', 120) * 1000;
    const t0 = Date.now();
    let client5xx = 0;
    let failedRid: string | undefined;
    await runVus({ vus, durationMs: ctx.durationMs, signal: ctx.signal, pauseMs: 100 }, async () => {
      const res = await ctx.client.get('/api/lab/now', { route: '/api/lab/now', expect: [200, 503] });
      if (res.status >= 500) {
        client5xx += 1;
        failedRid ??= res.headers[HEADERS.requestId.toLowerCase()];
      }
    });
    ctx.finding('client5xx', client5xx);
    if (!client5xx) ctx.note('负载期间没有出现 5xx：故障注入没有生效（featureFlags[\'lab.faults\'] 打开了吗？）');
    const from = new Date(t0 - 60_000).toISOString();
    await sleep(1500, ctx.signal);                                     // Nginx 写完最后几行

    // ---- 本地一侧
    const local = await queryLogs(ctx, { store: 'local', source: 'nginx', level: 'error', q: ctx.runId, from, limit: 10_000 });
    const localByUri = errorsByUri(local.rows ?? []);
    const localOut: Record<string, unknown> = {
      errors: sum(localByUri), byUri: localByUri, tookMs: local.meta?.tookMs, scannedBytes: local.meta?.scannedBytes, truncated: local.meta?.truncated,
    };
    ctx.finding('agreeLocal', sum(localByUri) === client5xx);
    if (failedRid) {
      const lookup = await queryLogs(ctx, { store: 'local', requestId: failedRid, from, limit: 50 });
      Object.assign(localOut, { lookupTookMs: lookup.meta?.tookMs, lookupRows: lookup.rows?.length ?? 0 });
    }
    ctx.finding('local', localOut);

    // ---- CloudWatch 一侧（LOG_DRIVER=cloudwatch 时）
    const cw = ctx.capabilities.modules.logging?.driver === 'cloudwatch';
    if (!cw) {
      ctx.finding('cloudwatch', { available: false });
      return;
    }
    const deadline = Date.now() + waitMs;
    let ingested = 0;
    while (Date.now() < deadline && !ctx.signal.aborted) {
      try {
        const r = await queryLogs(ctx, { store: 'cloudwatch', source: 'nginx', level: 'error', q: ctx.runId, from, to: new Date(Date.now() + 60_000).toISOString(), limit: 10_000 });
        ingested = sum(errorsByUri(r.rows ?? []));
        if (ingested >= sum(localByUri)) break;
      } catch (e) {
        if (e instanceof LogsApiError && e.status !== 502) throw e;
        ctx.log(`等待摄取时查询失败（继续）：${(e as Error).message}`);
      }
      await sleep(3000, ctx.signal);
    }
    const waitedMs = Date.now() - (deadline - waitMs);
    const statement = `filter run = "${ctx.runId}" and status >= 500 | stats count(*) as errors by uri`;
    const q = await insights(ctx, { source: 'nginx', q: statement, from, to: new Date().toISOString() });
    const cwByUri = statsByUri(q.rows);
    const cwOut: Record<string, unknown> = {
      available: true, waitedForIngestMs: waitedMs, ingestedBeforeQuery: ingested, errors: sum(cwByUri), byUri: cwByUri,
      insightsTookMs: q.meta.tookMs || q.wallMs, bytesScanned: q.meta.scannedBytes,
    };
    ctx.finding('agreeCloudwatch', sum(cwByUri) === sum(localByUri));
    if (failedRid) {
      const lookup = await queryLogs(ctx, { store: 'cloudwatch', requestId: failedRid, from, to: new Date().toISOString(), limit: 50 });
      Object.assign(cwOut, { lookupTookMs: lookup.meta?.tookMs, lookupRows: lookup.rows?.length ?? 0, instances: lookup.meta?.instances.length ?? 0 });
    }
    ctx.finding('cloudwatch', cwOut);
  },
});
