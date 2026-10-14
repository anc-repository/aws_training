/**
 * notification/worker-stop —— worker 停机时的扇出（04#notification 第 5 节步骤 7）。
 *
 *   npm run exp -- notification --label after --scenario worker-stop --fault-via ssh --ssh ec2-user@<EIP>
 *   （没有投递通道时 --fault-via skip，并按提示手工执行：sudo systemctl stop cloudalbum-worker … start）
 *
 * 时间线（experiment.json 的 faults）：第 5 秒 stop-worker.sh，第 50 秒 start-worker.sh。场景每 intervalSec 秒评论一次（随机种子用户），
 * 同时读管理员视图 capabilities 中 notification 的 data.inbox.visible（探针每 30 秒刷新一次）。观察：
 *   - 评论请求照常成功（Publish 在 api 进程，与 worker 无关），邮件照常到达邮箱（学员核对）；
 *   - 收件队列积压上升；worker 启动后被消费，sqs-copy 投递记录补齐（服务端证据：/api/admin/notifications/deliveries）。
 * db 档没有收件队列，本场景只在 after（sns）下有意义。
 */
import { defineScenario, numParam, type ScenarioContext } from '../_lib/scenario.js';
import { sleep } from '../_lib/util.js';
import { byChannel } from './fanout.js';
import { seededUsers } from './users.js';

interface InboxView { visible?: number; inFlight?: number }

async function inboxDepth(ctx: ScenarioContext): Promise<number | undefined> {
  const caps = await ctx.client.get('/api/capabilities', { route: '/api/capabilities', record: false });
  if (!caps.ok) return undefined;
  const inbox = caps.json<{ modules?: Record<string, { data?: { inbox?: InboxView } }> }>().modules?.notification?.data?.inbox;
  return inbox?.visible;
}

export default defineScenario({
  warmupWithRun: false,
  async run(ctx) {
    const users = seededUsers(ctx).filter((u) => u.photoId);
    if (!users.length) throw new Error('种子用户都没有照片：重新运行 seed-users.ts');
    const intervalSec = numParam(ctx, 'intervalSec', 5);
    const drainSec = numParam(ctx, 'drainSec', 120);
    const eventIds = new Set<string>();
    const depths: Array<{ t: number; visible?: number }> = [];
    let failures = 0;
    while (ctx.remainingMs() > 0 && !ctx.signal.aborted) {
      const u = users[Math.floor(Math.random() * users.length)]!;
      const res = await ctx.client.post(`/social/photos/${u.photoId}/comments`, {
        route: '/social/photos/:id/comments', json: { text: `worker-stop ${ctx.label} → ${u.alias}` }, expect: [201],
      });
      if (res.ok) {
        const id = res.json<{ comment?: { id?: string } }>().comment?.id;
        if (id) eventIds.add(`comment.created:${id}`);
      } else {
        failures += 1;
      }
      depths.push({ t: Math.round(ctx.elapsedMs() / 1000), visible: await inboxDepth(ctx) });
      await sleep(intervalSec * 1000, ctx.signal);
    }
    // 负载结束：等 worker（第 50 秒已启动）把积压消费完
    const deadline = Date.now() + drainSec * 1000;
    let counts: Record<string, number> = {};
    while (Date.now() < deadline && !ctx.signal.aborted) {
      const d = await ctx.client.get('/api/admin/notifications/deliveries', { route: '/api/admin/notifications/deliveries', record: false });
      counts = d.ok ? byChannel(d.json<{ items?: Array<{ event_id: string; channel: string; status: string; target: string | null; at: string }> }>().items ?? [], eventIds) : {};
      if ((counts['sqs-copy'] ?? 0) >= eventIds.size) break;
      await sleep(5000, ctx.signal);
    }
    const maxDepth = Math.max(0, ...depths.map((d) => d.visible ?? 0));
    ctx.finding('driver', ctx.capabilities.modules?.notification?.driver);
    ctx.finding('events', eventIds.size);
    ctx.finding('commentFailures', failures);
    ctx.finding('inboxDepthSeries', depths);
    ctx.finding('maxInboxDepth', maxDepth);
    ctx.finding('deliveriesByChannel', counts);
    ctx.business('worker_stop_comment_failures', failures);
    ctx.business('worker_stop_max_inbox_depth', maxDepth);
    ctx.business('worker_stop_inbox_missing', Math.max(0, eventIds.size - (counts['sqs-copy'] ?? 0)));
    ctx.note('到邮箱核对：worker 停止期间发布的评论通知照常到达（SNS 投递不依赖 worker）');
  },
});
