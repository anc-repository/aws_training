/**
 * notification/filter —— 订阅过滤策略（04#notification 第 5 节步骤 5）。
 *
 *   npm run exp -- notification --label after --scenario filter --param user=u1
 *
 * 只给一个种子用户（u1 的照片）评论一次 → 一个 comment.created（消息属性 userId=<u1 的 id>）。之后：
 *   - 服务端证据：GET /api/admin/notifications/deliveries?eventId=… —— sns 档 1 行 sns（Publish）+ 1 行 sqs-copy（收件队列收到全部
 *     消息，不设过滤策略）；db 档 1 行 email，且只发给 u1；
 *   - SNS 侧的过滤只能在 SNS 侧看到：邮箱里只有收件人为 `+u1` 的那封到达（所有别名进同一个邮箱，按收件人地址区分），
 *     CloudWatch 的 NumberOfNotificationsFilteredOut 增加（分钟级延迟；卡片用 aws-readonly 检查读取）。
 *     场景另外读一次管理员视图 capabilities（深度探针）的 metricsLastHour，作为参考值记录。
 */
import { defineScenario, strParam } from '../_lib/scenario.js';
import { sleep } from '../_lib/util.js';
import { seededUsers, timingOf } from './users.js';

interface DeliveryRow { event_id: string; channel: string; status: string; target: string | null }

export default defineScenario({
  warmupWithRun: false,
  async run(ctx) {
    const users = seededUsers(ctx);
    const alias = strParam(ctx, 'user', 'u1');
    const target = users.find((u) => u.alias === alias || u.email === alias);
    if (!target?.photoId) throw new Error(`种子用户 ${alias} 不存在或没有照片（${users.map((u) => u.alias).join(', ')}）`);
    const driver = String(ctx.capabilities.modules?.notification?.driver ?? 'unknown');
    ctx.finding('driver', driver);
    ctx.finding('recipient', target.email);
    ctx.finding('otherSubscribers', users.filter((u) => u !== target).map((u) => u.email));

    const res = await ctx.client.post(`/social/photos/${target.photoId}/comments`, {
      route: '/social/photos/:id/comments', json: { text: `filter test → only ${target.alias}` }, expect: [201],
    });
    if (!res.ok) throw new Error(`评论失败：HTTP ${res.status}`);
    const eventId = `comment.created:${res.json<{ comment?: { id?: string } }>().comment?.id ?? ''}`;
    ctx.finding('eventId', eventId);
    ctx.finding('notificationMs', timingOf(res, 'notification'));
    ctx.finding('pathSegment', res.path.modules.find((m) => m.module === 'notification')?.raw);

    let rows: DeliveryRow[] = [];
    for (let i = 0; i < 20 && !ctx.signal.aborted; i += 1) {
      await sleep(1000, ctx.signal);
      const d = await ctx.client.get(`/api/admin/notifications/deliveries?eventId=${encodeURIComponent(eventId)}`, { route: '/api/admin/notifications/deliveries', record: false });
      rows = d.ok ? d.json<{ items?: DeliveryRow[] }>().items ?? [] : [];
      if (driver !== 'sns' || rows.some((r) => r.channel === 'sqs-copy')) break;
    }
    const channels = rows.map((r) => `${r.channel}:${r.status}${r.target ? `→${r.target}` : ''}`);
    ctx.finding('deliveries', channels);
    const emailedOthers = rows.filter((r) => r.channel === 'email' && r.target && r.target.toLowerCase() !== target.email.toLowerCase()).length;
    ctx.finding('emailedOthers', emailedOthers);
    ctx.business('filter_emailed_others', emailedOthers);
    ctx.business('filter_inbox_copies', rows.filter((r) => r.channel === 'sqs-copy').length);

    // 参考值：深度探针读 CloudWatch（有分钟级延迟，不作为判定）
    const caps = await ctx.client.get('/api/capabilities?deep=1', { route: '/api/capabilities', record: false });
    if (caps.ok) {
      const data = caps.json<{ modules?: Record<string, { data?: { metricsLastHour?: unknown } }> }>().modules?.notification?.data;
      if (data?.metricsLastHour) ctx.finding('metricsLastHour', data.metricsLastHour);
    }
    if (driver === 'sns') ctx.note('到邮箱核对：只有收件人为 +' + target.alias + ' 的通知邮件到达；其他别名没有收到（SNS 订阅过滤策略按 userId 匹配）');
  },
});
