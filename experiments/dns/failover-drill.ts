/**
 * dns/failover-drill —— 故障转移演练（01#dns 第 5 节步骤 3）。需要 DNS_ROUTING_POLICY=failover 与健康检查：
 *
 *   scripts/module enable dns --domain <域名> --param RoutingPolicy=failover          # hook 自动加上 EnableHealthCheck=true
 *   npm run exp -- dns --label after --scenario failover-drill --fault-via ssm --upload
 *
 * 第 10 秒经投递通道在实例上执行 faults/stop-nginx.sh（停止 Nginx），结束时 faults/start-nginx.sh 恢复。本脚本每 intervalSec 秒
 * 向公共解析器查询记录、访问 http://<域名>/，并（有 AWS CLI 与凭证时）读取 Route 53 健康检查状态（us-east-1），记录三个时刻：
 * 健康检查变为不健康、客户端拿到备用记录、访问成功（S3 维护页，响应带 x-amz-request-id）。预期数十秒到数分钟，约等于
 * “检查间隔 × 失败阈值 + TTL + 解析器与客户端缓存”。
 */
import { spawnSync } from 'node:child_process';
import { timedGet } from '../_lib/probe.js';
import { defineScenario, numParam, strParam } from '../_lib/scenario.js';
import { sleep } from '../_lib/util.js';
import { domainOf, eipOf, resolveVia, serverEvidence } from './lib.js';

/** 半数以上的健康检查器报告 Failure；没有 AWS CLI / 凭证时 undefined */
function healthCheckFailing(id: string): boolean | undefined {
  if (!id) return undefined;
  const r = spawnSync('aws', ['route53', 'get-health-check-status', '--health-check-id', id, '--region', 'us-east-1', '--output', 'json'],
    { encoding: 'utf8', timeout: 15_000, windowsHide: true });
  if (r.status !== 0) return undefined;
  try {
    const j = JSON.parse(r.stdout) as { HealthCheckObservations?: Array<{ StatusReport?: { Status?: string } }> };
    const obs = j.HealthCheckObservations ?? [];
    return obs.length > 0 && obs.filter((o) => /^Failure/i.test(o.StatusReport?.Status ?? '')).length * 2 > obs.length;
  } catch {
    return undefined;
  }
}

export default defineScenario({
  warmupWithRun: false,
  async run(ctx) {
    const domain = domainOf(ctx);
    const eip = eipOf(ctx);
    const servers = strParam(ctx, 'resolver', '8.8.8.8').split(',').map((s) => s.trim()).filter(Boolean);
    const data = (ctx.capabilities.modules?.dns?.data ?? {}) as Record<string, unknown>;
    const hcId = strParam(ctx, 'healthCheckId', typeof data.healthCheckId === 'string' ? data.healthCheckId : '');
    const intervalMs = numParam(ctx, 'intervalSec', 5) * 1000;
    if (!domain) {
      ctx.note('没有域名（dns 未启用？）：故障转移演练需要 Route 53 的 failover 记录');
      return;
    }
    const marks: Record<string, number | undefined> = { unhealthy: undefined, secondaryAnswer: undefined, maintenanceOk: undefined, primaryBack: undefined };
    const timeline: Array<Record<string, unknown>> = [];
    while (!ctx.signal.aborted && ctx.remainingMs() > 0) {
      const t = Math.round(ctx.elapsedMs() / 100) / 10;
      const [res, page] = await Promise.all([resolveVia(domain, servers), timedGet(`http://${domain}/`, {}, 4000)]);
      const failing = healthCheckFailing(hcId);
      const secondary = res.answers.length > 0 && Boolean(eip) && !res.answers.includes(eip);
      const maintenance = page.status === 200 && 'x-amz-request-id' in page.headers;
      if (failing && marks.unhealthy === undefined) marks.unhealthy = t;
      if (secondary && marks.secondaryAnswer === undefined) marks.secondaryAnswer = t;
      if (secondary && maintenance && marks.maintenanceOk === undefined) marks.maintenanceOk = t;
      if (marks.secondaryAnswer !== undefined && res.answers.includes(eip) && marks.primaryBack === undefined) marks.primaryBack = t;
      timeline.push({ t, answers: res.answers, status: page.status, server: page.headers.server ?? null, healthCheckFailing: failing ?? null });
      await sleep(Math.min(intervalMs, Math.max(0, ctx.remainingMs())), ctx.signal);
    }
    ctx.finding('marks', marks);
    ctx.finding('failoverSec', marks.maintenanceOk);
    ctx.finding('timeline', timeline.slice(0, 120));
    if (!hcId) ctx.note('没有健康检查 ID：只记录客户端看到的切换（--param healthCheckId=，或启用 failover 后从 capabilities 读取）');
    ctx.finding('server', await serverEvidence(ctx, domain));
  },
});
