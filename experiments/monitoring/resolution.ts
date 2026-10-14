/**
 * monitoring/resolution —— 粒度（05#monitoring 第 5 节步骤 4）。
 *
 *   npm run exp -- monitoring --label after --scenario resolution --fault-via ssh --ssh ec2-user@<EIP> --upload
 *   scripts/module enable monitoring --param DetailedMonitoring=true     # 详细监控（按实例计费），然后重做一次
 *
 * 第 30 秒 faults/cpu-spike.sh 占满一个核 spikeSec 秒；之后等待 waitSec 秒让 EC2 指标出现，再经 /api/lab/monitoring/series 读取：
 *   本地 host.loadavg1（LabMetricsStore 每 10 秒一个主机样本；host.cpuPct 是采样进程自己的 CPU，看不到别的进程的尖峰）、
 *   AWS/EC2 CPUUtilization 的 period=60 与 period=300（基础监控只有 5 分钟一个点，period=60 也拿不到更细的数据）。
 * 同一个 3 分钟尖峰在 5 分钟基础监控里可能被平均成小坡；1 分钟详细监控与本地样本能看清。
 */
import { defineScenario, numParam } from '../_lib/scenario.js';
import { sleep } from '../_lib/util.js';
import { instanceIdOf, series, type SeriesPoint } from './common.js';

function windowStats(points: readonly SeriesPoint[] | undefined, from: number, to: number): { n: number; max?: number } {
  const inside = (points ?? []).filter((p) => p.t >= from && p.t <= to);
  return { n: inside.length, ...(inside.length ? { max: Math.round(Math.max(...inside.map((p) => p.v)) * 10) / 10 } : {}) };
}

export default defineScenario({
  warmupWithRun: false,
  async run(ctx) {
    const spikeSec = numParam(ctx, 'spikeSec', 180);
    const waitSec = numParam(ctx, 'waitSec', 420);
    const instanceId = instanceIdOf(ctx);
    const t0 = Date.now();
    const spikeFrom = t0 + 30_000;
    const spikeTo = spikeFrom + spikeSec * 1000;
    ctx.finding('spike', { from: new Date(spikeFrom).toISOString(), to: new Date(spikeTo).toISOString(), seconds: spikeSec });
    ctx.finding('instanceId', instanceId ?? null);
    const until = spikeTo + waitSec * 1000;
    ctx.log(`  尖峰 ${spikeSec} 秒（第 30 秒开始，由 faults/cpu-spike.sh 制造），之后等待 ${waitSec} 秒`);
    await sleep(Math.max(0, Math.min(until - Date.now(), ctx.remainingMs() - 30_000)), ctx.signal);

    const since = new Date(t0 - 10 * 60_000);
    const end = new Date();
    const [local, p60, p300] = await Promise.all([
      series(ctx, { name: 'host.loadavg1', source: 'local', stat: 'max', period: 10, since, until: end }),
      instanceId ? series(ctx, { name: 'CPUUtilization', source: 'cloudwatch', namespace: 'AWS/EC2', stat: 'max', period: 60, since, until: end, instanceId }) : Promise.resolve(undefined),
      instanceId ? series(ctx, { name: 'CPUUtilization', source: 'cloudwatch', namespace: 'AWS/EC2', stat: 'avg', period: 300, since, until: end, instanceId }) : Promise.resolve(undefined),
    ]);
    // EC2 的 5 分钟点以周期起点为时间戳：把窗口向前放宽一个周期
    const l = windowStats(local, spikeFrom, spikeTo);
    const a = windowStats(p60, spikeFrom - 60_000, spikeTo);
    const b = windowStats(p300, spikeFrom - 300_000, spikeTo);
    ctx.finding('local', { ...l, points: (local ?? []).filter((p) => p.t >= spikeFrom - 60_000 && p.t <= spikeTo + 60_000) });
    ctx.finding('ec2Period60', p60 === undefined ? { unavailable: true } : { ...a, points: p60.slice(-30) });
    ctx.finding('ec2Period300', p300 === undefined ? { unavailable: true } : { ...b, points: p300.slice(-12) });
    ctx.finding('detailedMonitoringInferred', a.n > b.n + 1);
    ctx.business('local_points_in_spike', l.n);
    if (l.max !== undefined) ctx.business('local_max_load', l.max);
    ctx.business('ec2_points_60', a.n);
    ctx.business('ec2_points_300', b.n);
    if (a.max !== undefined) ctx.business('ec2_max_60', a.max);
    if (b.max !== undefined) ctx.business('ec2_max_300', b.max);
    if (!instanceId) ctx.note('capabilities 中没有 EC2 实例 ID：只有本地一侧');
  },
});
