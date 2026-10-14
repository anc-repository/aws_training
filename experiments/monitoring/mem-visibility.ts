/**
 * monitoring/mem-visibility —— 内存可见性（05#monitoring 第 5 节步骤 3）。
 *
 *   npm run exp -- monitoring --label after --scenario mem-visibility --upload
 *
 * 1. POST /api/lab/faults {"type":"mem","durationSec":holdSec} 共 mib/64 次（每次 64 MiB，上限 512 MiB；运行时热键
 *    featureFlags['lab.faults'] 需为 true），保持 holdSec 秒后 DELETE /api/lab/faults 释放；
 * 2. 再等 settleSec 秒（CloudWatch 指标出现延迟为分钟级），读取三条曲线（都经应用的 /api/lab/monitoring/series，服务端证据）：
 *    本地 host.memUsedRatio（LabMetricsStore 主机采样）、CWAgent mem_used_percent（InstanceId 维度）、
 *    AWS/EC2 MemoryUtilization（EC2 没有这个指标，应为 0 个点）。
 */
import { defineScenario, numParam } from '../_lib/scenario.js';
import { sleep } from '../_lib/util.js';
import { instanceIdOf, series, type SeriesPoint } from './common.js';

function stats(points: readonly SeriesPoint[] | undefined, from: number, to: number): { n: number; max?: number; baseline?: number } {
  const inside = (points ?? []).filter((p) => p.t >= from && p.t <= to);
  const before = (points ?? []).filter((p) => p.t < from);
  return {
    n: inside.length,
    ...(inside.length ? { max: Math.max(...inside.map((p) => p.v)) } : {}),
    ...(before.length ? { baseline: before.reduce((a, p) => a + p.v, 0) / before.length } : {}),
  };
}

export default defineScenario({
  warmupWithRun: false,
  async run(ctx) {
    const mib = Math.min(512, Math.max(64, Math.round(numParam(ctx, 'mib', 256) / 64) * 64));
    const holdSec = numParam(ctx, 'holdSec', 300);
    const settleSec = numParam(ctx, 'settleSec', 120);
    const instanceId = instanceIdOf(ctx);
    ctx.finding('instanceId', instanceId ?? null);
    if (!instanceId) ctx.note('capabilities 中没有 EC2 实例 ID（不在 EC2 上？）：CloudWatch 一侧按 InstanceId 查询会是空的');

    const t0 = new Date();
    for (let i = 0; i < mib / 64; i += 1) {
      const r = await ctx.client.post('/api/lab/faults', { json: { type: 'mem', durationSec: holdSec }, record: false, expect: [201] });
      if (r.status !== 201) throw new Error(`POST /api/lab/faults → ${r.status}：${r.text().slice(0, 200)}（运行时热键 featureFlags['lab.faults'] 需为 true）`);
    }
    ctx.log(`  已占用 ${mib} MiB，保持 ${holdSec} 秒`);
    await sleep(Math.min(holdSec * 1000, Math.max(1000, ctx.remainingMs() - (settleSec + 60) * 1000)), ctx.signal);
    await ctx.client.del('/api/lab/faults', { record: false, expect: [200] });
    const t1 = new Date();
    ctx.log(`  已释放；再等 ${settleSec} 秒让 CloudWatch 指标出现`);
    await sleep(Math.min(settleSec * 1000, Math.max(0, ctx.remainingMs() - 30_000)), ctx.signal);

    const since = new Date(t0.getTime() - 10 * 60_000);
    const until = new Date();
    const [local, agent, ec2] = await Promise.all([
      series(ctx, { name: 'host.memUsedRatio', source: 'local', stat: 'max', period: 60, since, until }),
      series(ctx, { name: 'mem_used_percent', source: 'cloudwatch', namespace: 'CWAgent', stat: 'max', period: 60, since, until, ...(instanceId ? { instanceId } : {}) }),
      series(ctx, { name: 'MemoryUtilization', source: 'cloudwatch', namespace: 'AWS/EC2', stat: 'max', period: 60, since, until, ...(instanceId ? { instanceId } : {}) }),
    ]);
    const from = t0.getTime() - 60_000;
    const to = t1.getTime() + 60_000;
    const l = stats(local, from, to);
    const a = stats(agent, from, to);
    const e = stats(ec2, from, to);
    ctx.finding('window', { from: new Date(from).toISOString(), to: new Date(to).toISOString(), mib });
    ctx.finding('local', { ...l, points: (local ?? []).slice(-40) });
    ctx.finding('cwagent', agent === undefined ? { unavailable: true } : { ...a, points: agent.slice(-40) });
    ctx.finding('ec2', ec2 === undefined ? { unavailable: true } : { ...e, totalPoints: ec2.length });
    if (l.max !== undefined && l.baseline !== undefined) ctx.business('local_mem_delta_pct', Math.round((l.max - l.baseline) * 1000) / 10);
    ctx.business('cwagent_mem_points', a.n);
    if (a.max !== undefined && a.baseline !== undefined) ctx.business('cwagent_mem_delta_pct', Math.round((a.max - a.baseline) * 10) / 10);
    ctx.business('ec2_mem_points', ec2?.length ?? 0);
    if (!a.n) ctx.note('CWAgent mem_used_percent 没有数据点：Agent 是否运行（keys 模式不投放片段）？指标是否还没出现（再等几分钟重跑）？');
  },
});
