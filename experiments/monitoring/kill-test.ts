/**
 * monitoring/kill-test —— 宕机实验（05#monitoring 第 5 节步骤 2、第 12 节；06 PM-M30）。
 *
 *   npm run exp -- monitoring --label before --scenario kill-test --param phase=service --fault-via ssh --ssh ec2-user@<EIP>
 *   npm run exp -- monitoring --label after  --scenario kill-test --param phase=service --upload
 *   npm run exp -- monitoring --label stop-instance --scenario kill-test --param phase=instance --upload   # 选做，单独运行
 *
 * --param phase=service|instance|all（auto：平台模式 service，独立模式 all）：
 *   service  faults/stop-app.sh（经投递通道，root）停 api 与 worker，downSec 秒后启动；
 *   instance faults/stop-instance.sh（运维机 / 工作台上的 AWS CLI，调用者凭证）停止实验机，instanceDownSec 秒后启动并等管理通道恢复。
 * 恢复后读取服务端记录（判定依据）：
 *   - 本地：alert_events 在宕机期间的状态变化条数——worker 与 api 一起停了，评估器沉默，应为 0；
 *   - CloudWatch：app-heartbeat（TreatMissingData=breaching）在宕机期间是否进入 ALARM，以及距宕机开始多少秒（DescribeAlarmHistory）。
 * 宕机的开始与结束只用客户端探测（/api/health/live）划时间窗。平台模式下 stop-instance 只接受 phase=instance，
 * before / after 只接受 phase=service（两侧场景参数一致，04 §7.4 第 8 步）；不符合时场景报错退出。
 */
import { defineScenario, numParam, strParam } from '../_lib/scenario.js';
import { sleep } from '../_lib/util.js';
import { history, isPlatform, observeOutage, secondsBetween, transitionsBetween, type Transition } from './common.js';

type Phase = 'service' | 'instance';

export function resolvePhase(param: string, platform: boolean): 'service' | 'instance' | 'all' {
  if (param === 'service' || param === 'instance' || param === 'all') return param;
  return platform ? 'service' : 'all';
}

/** PM-M30 的组合约束（平台模式） */
export function phaseProblem(label: string, phase: string, platform: boolean): string | undefined {
  if (label === 'stop-instance' && phase !== 'instance') return '--label stop-instance 只接受 --param phase=instance';
  if (platform && (label === 'before' || label === 'after') && phase !== 'service') return '平台模式：before / after 只接受 --param phase=service（或缺省）';
  return undefined;
}

export default defineScenario({
  warmupWithRun: false,
  async run(ctx) {
    const platform = isPlatform(ctx);
    const phase = resolvePhase(strParam(ctx, 'phase', 'auto'), platform);
    const problem = phaseProblem(ctx.label, phase, platform);
    if (problem) throw new Error(problem);
    const downSec = numParam(ctx, 'downSec', 300);
    const instanceDownSec = numParam(ctx, 'instanceDownSec', 360);
    const pollSec = numParam(ctx, 'pollSec', 10);
    const cw = ctx.capabilities.modules?.monitoring?.driver === 'cloudwatch';
    ctx.finding('phase', phase);
    ctx.finding('platform', platform);
    ctx.finding('startedAt', new Date().toISOString());

    const phases: Phase[] = phase === 'all' ? ['service', 'instance'] : [phase];
    const results: Record<string, unknown> = {};
    for (const p of phases) {
      // all：服务阶段结束后 stop-instance.sh 再等 120 秒才停实例（见脚本）
      const remainingSec = Math.max(5, Math.floor(ctx.remainingMs() / 1000));
      const waitDownSec = Math.min(p === 'service' ? 120 : phase === 'all' ? 300 : 180, remainingSec);
      const maxDownSec = Math.min(p === 'service' ? downSec + 240 : instanceDownSec + 900, remainingSec);
      ctx.log(`  阶段 ${p}：等待宕机（≤${waitDownSec} 秒），再等恢复（≤${maxDownSec} 秒）`);
      const o = await observeOutage(ctx, { pollSec, waitDownSec, maxDownSec });
      if (!o.downAt) {
        results[p] = { observed: false, note: '没有观察到宕机（故障脚本是否执行？--fault-via ssh|ssm|local）' };
        ctx.note(`阶段 ${p}：没有观察到宕机`);
        continue;
      }
      if (!o.upAt) {
        results[p] = { observed: true, downAt: o.downAt.toISOString(), recovered: false };
        ctx.note(`阶段 ${p}：在 ${maxDownSec} 秒内没有恢复`);
        break;
      }
      // 恢复后应用要几秒才能读库：history 带重试
      await sleep(5000, ctx.signal);
      const since = new Date(o.downAt.getTime() - 60_000);
      const local = await history(ctx, 'api-heartbeat', 'local', since);
      const all = cw ? await history(ctx, 'app-heartbeat', 'cloudwatch', since) : undefined;
      // upAt 是客户端轮询看到的恢复时刻（最多晚 pollSec 秒）：重启后评估器的第一轮评估不算“宕机期间”
      const localDuring: Transition[] = transitionsBetween(local?.local, o.downAt, new Date(o.upAt.getTime() - pollSec * 1000));
      const cwDuring = transitionsBetween(all?.cloudwatch, o.downAt, new Date(o.upAt.getTime() + 60_000));
      const cwAlarmAt = cwDuring.find((t) => t.to === 'ALARM')?.at;
      results[p] = {
        observed: true, downAt: o.downAt.toISOString(), upAt: o.upAt.toISOString(), outageSec: secondsBetween(o.downAt, o.upAt),
        localTransitionsDuringOutage: localDuring, ...(cw ? { cloudwatchTransitions: cwDuring, cloudwatchAlarmAt: cwAlarmAt ?? null } : {}),
        ...(all?.cloudwatchError ? { cloudwatchError: all.cloudwatchError } : {}),
      };
      // 业务指标取第一个（主）阶段：before / after 成对比较时两侧都是 service
      if (p === phases[0]) {
        ctx.business('outage_sec', secondsBetween(o.downAt, o.upAt));
        ctx.business('local_alerts_during_outage', localDuring.length);
        if (cw) {
          ctx.business('cw_heartbeat_alarm', cwAlarmAt ? 1 : 0);
          ctx.business('cw_detect_sec', secondsBetween(o.downAt, cwAlarmAt));
        }
      }
      ctx.log(`  阶段 ${p}：宕机 ${secondsBetween(o.downAt, o.upAt)} 秒；本地状态变化 ${localDuring.length} 条${cw ? `；CloudWatch app-heartbeat ${cwAlarmAt ? `在 ${secondsBetween(o.downAt, cwAlarmAt)} 秒后进入 ALARM` : '没有进入 ALARM'}` : ''}`);
    }
    ctx.finding('phases', results);
    if (cw) ctx.note('SNS 邮件的到达时间请在邮箱中记录（卡片的手动确认）；本地评估器在宕机期间不会发出任何通知');
  },
});
