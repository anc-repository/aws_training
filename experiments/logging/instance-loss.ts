/**
 * logging/instance-loss —— 实例没了，日志还在吗（05#logging 第 5 节步骤 3）。
 *
 *   # 先在旧实例上产生请求并记下一个 X-CloudAlbum-Request-Id，然后替换实例：
 *   #   autoscaling：aws autoscaling terminate-instance-in-auto-scaling-group --instance-id <id> --no-should-decrement-desired-capacity
 *   #   单实例：scripts/module rebuild-instance（数据卷改挂到新实例：本地日志随卷迁移，单实例下看不出差别）
 *   npm run exp -- logging --label after --scenario instance-loss --param requestId=<rid> --upload
 *
 * 用同一个 requestId 分别查本地（当前实例的文件）与 CloudWatch（跨所有日志流），记录各自找到的行数与来自哪些实例。
 * 服务端证据：两侧的查询都在服务端执行；CloudWatch 一侧的行带日志流（= 产生它的实例 ID）。
 */
import { defineScenario, strParam } from '../_lib/scenario.js';
import { queryLogs } from './logs-api.js';

export default defineScenario({
  warmupWithRun: false,
  async run(ctx) {
    const rid = strParam(ctx, 'requestId', '');
    const hours = Number(strParam(ctx, 'hours', '24')) || 24;
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(rid)) {
      ctx.note('需要 --param requestId=<旧实例上产生的 X-CloudAlbum-Request-Id>');
      ctx.finding('requestId', null);
      return;
    }
    const from = new Date(Date.now() - hours * 3600_000).toISOString();
    const current = ctx.capabilities.app.instance.id;
    const local = await queryLogs(ctx, { store: 'local', requestId: rid, from, limit: 100 });
    ctx.finding('currentInstance', current);
    ctx.finding('local', { rows: local.rows?.length ?? 0, scannedBytes: local.meta?.scannedBytes });
    if (ctx.capabilities.modules.logging?.driver !== 'cloudwatch') {
      ctx.finding('cloudwatch', { available: false });
      return;
    }
    const cw = await queryLogs(ctx, { store: 'cloudwatch', requestId: rid, from, limit: 100 });
    const instances = [...new Set((cw.rows ?? []).map((r) => r.instanceId).filter((x): x is string => Boolean(x)))];
    ctx.finding('cloudwatch', { available: true, rows: cw.rows?.length ?? 0, instances, fromOtherInstance: instances.some((i) => i !== current) });
  },
});
