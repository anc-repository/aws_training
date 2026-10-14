/**
 * notification/fanout —— 一次事件的站外扇出（04#notification 第 5 节步骤 2、4）。
 *
 *   npm run exp -- notification --label before --scenario fanout     # NOTIFY_DRIVER=db：逐个调用 EmailPort
 *   scripts/module enable notification --param AdminEmail=<你的邮箱 +admin 别名> --no-migrate
 *   npm run exp -- notification --label after  --scenario fanout     # NOTIFY_DRIVER=sns：一次 Publish
 *
 * 前置：seed-users.ts 准备的种子用户（每人一张公开照片、已开启邮件通知）。场景以管理员身份：
 *   1. 管理员广播：POST /api/lab/notification/compare（同一个 report.ready 测试事件经 db 与 sns 驱动各发一次；该端点由集成阶段
 *      登记，返回 404 时跳过并记 note）；
 *   2. comments 条评论，随机评在种子用户的照片上 → 每条产生一个 comment.created（audience=user）。QUEUE_DRIVER=sync 时扇出在
 *      评论请求内执行，Server-Timing 的 notification 段就是 NotifierPort.publish 的耗时（db 档还含 email 段）；
 *   3. 等待 waitSec 秒后读服务端的投递记录 GET /api/admin/notifications/deliveries（服务端证据）：
 *      db 档每条事件 1 行 email（outbox / ses）；sns 档每条事件 1 行 sns，worker 消费收件队列后再加 1 行 sqs-copy。
 * 发现：driver、每条事件的投递行数（按渠道）、notification 段耗时分布、广播的两侧耗时与调用次数。
 */
import { defineScenario, numParam } from '../_lib/scenario.js';
import { percentile, round1, sleep } from '../_lib/util.js';
import { seededUsers, timingOf } from './users.js';

interface DeliveryRow { event_id: string; channel: string; status: string; target: string | null; at: string }

export function byChannel(rows: readonly DeliveryRow[], eventIds: ReadonlySet<string>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) if (eventIds.has(r.event_id)) out[r.channel] = (out[r.channel] ?? 0) + 1;
  return out;
}

export default defineScenario({
  warmupWithRun: false,
  async run(ctx) {
    const users = seededUsers(ctx).filter((u) => u.photoId);
    if (!users.length) throw new Error('种子用户都没有照片：重新运行 seed-users.ts');
    const driver = String(ctx.capabilities.modules?.notification?.driver ?? 'unknown');
    ctx.finding('driver', driver);
    ctx.finding('recipients', users.length);

    // 1. 管理员广播（功能对照端点；未登记时跳过）
    const cmp = await ctx.client.post('/api/lab/notification/compare', { route: '/api/lab/notification/compare', json: {}, expect: [200, 404, 501] });
    if (cmp.status === 200) {
      const r = cmp.json<{ recipients?: number; db?: { ms?: number; calls?: number }; sns?: { ms?: number; calls?: number; skipped?: string } }>();
      ctx.finding('broadcast', r);
      ctx.business('broadcast_db_ms', r.db?.ms);
      ctx.business('broadcast_db_email_calls', r.db?.calls);
      if (r.sns && !r.sns.skipped) ctx.business('broadcast_sns_ms', r.sns.ms);
    } else {
      ctx.note(`POST /api/lab/notification/compare 返回 ${cmp.status}：本次不测管理员广播（只测按用户的评论扇出）`);
    }

    // 2. 评论 → comment.created
    const n = numParam(ctx, 'comments', 20);
    const eventIds = new Set<string>();
    const notifyMs: number[] = [];
    const emailMs: number[] = [];
    let failed = 0;
    for (let i = 0; i < n && !ctx.signal.aborted; i += 1) {
      const u = users[Math.floor(Math.random() * users.length)]!;
      const res = await ctx.client.post(`/social/photos/${u.photoId}/comments`, {
        route: '/social/photos/:id/comments', json: { text: `fanout ${ctx.label} #${i + 1} → ${u.alias}` }, expect: [201],
      });
      if (!res.ok) {
        failed += 1;
        continue;
      }
      const id = res.json<{ comment?: { id?: string } }>().comment?.id;
      if (id) eventIds.add(`comment.created:${id}`);
      const t = timingOf(res, 'notification');
      if (t !== undefined) notifyMs.push(t);
      const e = timingOf(res, 'email');
      if (e !== undefined) emailMs.push(e);
    }
    ctx.finding('comments', eventIds.size);
    ctx.finding('commentFailures', failed);
    ctx.finding('notificationMsP50', round1(percentile(notifyMs, 50)));
    ctx.finding('notificationMsP95', round1(percentile(notifyMs, 95)));
    ctx.finding('emailMsP50', round1(percentile(emailMs, 50)));
    ctx.business('notification_publish_ms_p50', percentile(notifyMs, 50));
    ctx.business('notification_publish_ms_p95', percentile(notifyMs, 95));

    // 3. 服务端证据：投递记录
    const waitSec = numParam(ctx, 'waitSec', driver === 'sns' ? 20 : 2);
    const deadline = Date.now() + waitSec * 1000;
    let counts: Record<string, number> = {};
    do {
      await sleep(1000, ctx.signal);
      const d = await ctx.client.get('/api/admin/notifications/deliveries', { route: '/api/admin/notifications/deliveries', record: false });
      if (!d.ok) {
        ctx.note(`/api/admin/notifications/deliveries 返回 ${d.status}`);
        break;
      }
      counts = byChannel(d.json<{ items?: DeliveryRow[] }>().items ?? [], eventIds);
      if (driver !== 'sns' || (counts['sqs-copy'] ?? 0) >= eventIds.size) break;
    } while (Date.now() < deadline && !ctx.signal.aborted);
    ctx.finding('deliveriesByChannel', counts);
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    ctx.finding('deliveriesPerEvent', eventIds.size ? round1(total / eventIds.size) : undefined);
    ctx.business('deliveries_email', counts.email ?? 0);
    ctx.business('deliveries_sns', counts.sns ?? 0);
    ctx.business('deliveries_inbox', counts['sqs-copy'] ?? 0);
    if (driver === 'sns' && (counts['sqs-copy'] ?? 0) < eventIds.size) {
      ctx.note('收件队列的 sqs-copy 记录还没到齐：worker 是否在运行（systemctl status cloudalbum-worker），收件队列订阅是否确认');
    }
  },
});
