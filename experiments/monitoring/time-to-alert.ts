/**
 * monitoring/time-to-alert —— 告警时延（05#monitoring 第 5 节步骤 1）。
 *
 *   npm run exp -- monitoring --label before --scenario time-to-alert --upload    # 只有本地评估器
 *   scripts/module enable monitoring --param AlertEmail=you@example.com
 *   npm run exp -- monitoring --label after  --scenario time-to-alert --upload    # 本地 + CloudWatch 并排
 *
 * 以恒定速率请求合成 5xx 端点 /api/lab/monitoring/synthetic（rate 的请求返回 503），直到告警进入 ALARM：
 *   - 本地：本地告警评估器（worker 内，每 30 秒）把 app-5xx-rate 的状态变化写入 alert_events；
 *   - CloudWatch：app-5xx-rate（Http5xx / Requests，1 分钟 × 3 of 5）的 DescribeAlarmHistory。
 * 两个时间都取服务端记录的状态变化时刻（不是客户端看到的响应），减去负载开始时刻。
 * source=fault-api 时改用共享故障注入 POST /api/lab/faults {"type":"error5xx"}（文档原写法），负载打 /api/public/now；
 * 在集成阶段让 /api/health/* 与 /api/lab/* 豁免 error5xx 之前不要用它（healthcheck.sh 会重启 api，故障随进程消失）。
 * SNS 邮件的到达时间在邮箱中手工记录（卡片的 manual 检查）。
 */
import { defineScenario, numParam, strParam } from '../_lib/scenario.js';
import { sleep } from '../_lib/util.js';
import { alarms, firstTransitionTo, history, secondsBetween, type Transition } from './common.js';

const ALARM = 'app-5xx-rate';

export default defineScenario({
  warmupWithRun: false,
  async run(ctx) {
    const rate = numParam(ctx, 'rate', 0.5);
    const rps = numParam(ctx, 'rps', 5);
    const pollSec = numParam(ctx, 'pollSec', 15);
    const maxWaitSec = Math.min(numParam(ctx, 'maxWaitSec', 720), Math.floor(ctx.remainingMs() / 1000));
    const source = strParam(ctx, 'source', 'synthetic');
    const cw = ctx.capabilities.modules?.monitoring?.driver === 'cloudwatch';

    const pre = await alarms(ctx);
    ctx.finding('evaluator', pre?.local.evaluator ?? null);
    ctx.finding('preState', {
      local: pre?.local.alarms.find((a) => a.name === ALARM)?.state ?? null,
      cloudwatch: pre?.cloudwatch.alarms?.find((a) => a.name === ALARM)?.state ?? null,
    });
    if (!pre?.local.evaluator) ctx.note('本地告警评估器还没有心跳（worker 未运行？）：本地一侧可能测不到');

    const t0 = new Date();
    ctx.finding('loadStartedAt', t0.toISOString());
    ctx.finding('source', source);
    if (source === 'fault-api') {
      const f = await ctx.client.post('/api/lab/faults', { json: { type: 'error5xx', rate, durationSec: maxWaitSec + 60 }, record: false, expect: [201] });
      if (f.status !== 201) throw new Error(`POST /api/lab/faults → ${f.status}：${f.text().slice(0, 200)}（运行时热键 featureFlags['lab.faults'] 需为 true）`);
    }

    // 负载：开环，每 1/rps 秒发一个请求，不等前一个完成
    const stop = new AbortController();
    let sent = 0;
    let errors5xx = 0;
    const inFlight = new Set<Promise<void>>();
    const target = source === 'fault-api' ? '/api/public/now' : `/api/lab/monitoring/synthetic?rate=${rate}`;
    const route = source === 'fault-api' ? '/api/public/now' : '/api/lab/monitoring/synthetic';
    const loader = (async () => {
      while (!stop.signal.aborted && !ctx.signal.aborted) {
        const p = ctx.client.get(target, { route, expect: [200, 500, 502, 503, 504], timeoutMs: 10_000 })
          .then((r) => { sent += 1; if (r.status >= 500) errors5xx += 1; })
          .catch(() => { sent += 1; })
          .finally(() => { inFlight.delete(p); });
        inFlight.add(p);
        await sleep(1000 / rps, stop.signal);
      }
    })();

    // 轮询服务端记录的状态变化
    let localAt: string | undefined;
    let cwAt: string | undefined;
    let localHist: Transition[] = [];
    let cwHist: Transition[] = [];
    let cwError: string | undefined;
    const deadline = t0.getTime() + maxWaitSec * 1000;
    while (!ctx.signal.aborted && Date.now() < deadline && !(localAt && (!cw || cwAt))) {
      await sleep(pollSec * 1000, ctx.signal);
      const h = await history(ctx, ALARM, cw ? 'both' : 'local', t0);
      if (!h) continue;
      localHist = h.local ?? localHist;
      cwHist = h.cloudwatch ?? cwHist;
      cwError = h.cloudwatchError;
      localAt ??= firstTransitionTo(h.local, 'ALARM', t0);
      if (cw) cwAt ??= firstTransitionTo(h.cloudwatch, 'ALARM', t0);
      ctx.log(`  ${Math.round((Date.now() - t0.getTime()) / 1000)}s：本地 ${localAt ? 'ALARM' : '未告警'}${cw ? `，CloudWatch ${cwAt ? 'ALARM' : '未告警'}` : ''}（已发 ${sent} 个请求，${errors5xx} 个 5xx）`);
    }
    stop.abort();
    await loader;
    await Promise.allSettled([...inFlight]);
    if (source === 'fault-api') {
      for (let i = 0; i < 5; i += 1) {
        const d = await ctx.client.del('/api/lab/faults', { record: false, expect: [200] });
        if (d.status === 200) break;
        await sleep(1000, ctx.signal);
      }
    }

    const localSec = secondsBetween(t0, localAt);
    const cwSec = secondsBetween(t0, cwAt);
    ctx.finding('localAlarmAt', localAt ?? null);
    ctx.finding('cloudwatchAlarmAt', cwAt ?? null);
    ctx.finding('localTransitions', localHist);
    if (cw) ctx.finding('cloudwatchTransitions', cwHist);
    if (cwError) ctx.finding('cloudwatchError', cwError);
    ctx.finding('requests', sent);
    ctx.finding('synthetic5xx', errors5xx);
    ctx.finding('delivery', { local: '站内信 + EmailPort（实例宕机即失效）', cloudwatch: cw ? 'SNS ops-alarms 主题（实例宕机也能发出）' : null });
    ctx.business('local_detect_sec', localSec);
    ctx.business('local_alarm', localAt ? 1 : 0);
    if (cw) {
      ctx.business('cw_detect_sec', cwSec);
      ctx.business('cw_alarm', cwAt ? 1 : 0);
    }
    if (!localAt) ctx.note(`本地评估器在 ${maxWaitSec} 秒内没有进入 ALARM（worker 是否在运行？alerts.yaml 的 app-5xx-rate 阈值？）`);
    if (cw && !cwAt) ctx.note(`CloudWatch 告警在 ${maxWaitSec} 秒内没有进入 ALARM（上报是否正常？告警阈值、3 of 5 个数据点）`);
  },
});
