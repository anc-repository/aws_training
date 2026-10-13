// backend/src/adapters/notification/db.ts —— NotifierPort 的 `db` 驱动（本地实现，04#notification 第 1 节）
//
// 站内信始终由核心服务（services/notifications.ts）写 notifications 表；本驱动只负责“站外渠道”：
// - audience=user：查 notification_prefs，email_enabled=true 时调用 EmailPort.send（category=notification），返回 channels=['email']；
//   否则返回 []，路径头记 notification=db:none。
// - audience=admin：查出全部管理员，逐个发邮件（不看偏好）——接收人越多，EC2 串行干的活越多，这正是与 SNS 扇出对比的地方。
// - 每次站外投递写 notification_deliveries；同一事件、渠道、目标已成功投递过则跳过（队列至少一次投递时的幂等）。
// - 用户打开 / 关闭“邮件通知”只是改一个布尔值，不需要任何确认（sns 档需要点确认邮件）。
import { randomUUID } from 'node:crypto';
import type { AdapterDeps } from '../types.js';
import { need } from '../types.js';
import type { AdapterMeta, ProbeResult } from '../../ports/common.js';
import type { NotificationEvent, NotifierPort } from '../../ports/notifier.js';
import { markPath } from '../../observability/request-context.js';
import { deliveryExists, getNotificationPrefs, insertDelivery, setNotificationPrefs } from '../../repositories/notifications.js';
import { findUserById, listAdmins, type UserRow } from '../../repositories/users.js';
import { countOf } from '../../db/dialect.js';

export class DbNotifier implements NotifierPort {
  readonly meta: AdapterMeta = { module: 'notification', driver: 'db', awsService: null, authoritative: false };

  constructor(protected readonly deps: AdapterDeps) {}

  private async recipients(evt: NotificationEvent): Promise<UserRow[]> {
    const db = need(this.deps, 'db', 'DbNotifier');
    if (evt.audience === 'admin') return listAdmins(db);
    const user = await findUserById(db, evt.recipientUserId);
    if (!user) return [];
    const prefs = await getNotificationPrefs(db, user.id);
    return prefs.emailEnabled ? [user] : [];
  }

  async publish(evt: NotificationEvent): Promise<{ deliveryId: string; channels: Array<'email' | 'sns'> }> {
    const db = need(this.deps, 'db', 'DbNotifier');
    const deliveryId = randomUUID();
    const targets = (await this.recipients(evt)).filter((u) => (u.email_status ?? 'ok') === 'ok');
    if (!targets.length) {
      markPath('notification', 'db:none');
      return { deliveryId, channels: [] };
    }
    const email = need(this.deps, 'email', 'DbNotifier');
    const base = this.deps.cfg.core.APP_BASE_URL.replace(/\/+$/, '');
    const link = evt.link ? (/^https?:\/\//.test(evt.link) ? evt.link : `${base}${evt.link.startsWith('/') ? '' : '/'}${evt.link}`) : undefined;
    let sent = 0;
    let lastError: unknown;
    for (const u of targets) {
      if (await deliveryExists(db, evt.eventId, 'email', u.email)) {
        sent += 1;
        continue;
      }
      try {
        const r = await email.send({
          to: [u.email],
          subject: evt.title,
          text: [evt.body, ...(link ? ['', link] : [])].join('\n'),
          category: evt.type === 'report.ready' ? 'report' : 'notification',
          tags: { event: evt.type, eventId: evt.eventId },
        });
        await insertDelivery(db, { eventId: evt.eventId, channel: 'email', target: u.email, status: r.delivered ? 'sent' : 'stored', detail: `${r.transport}:${r.messageId}` });
        sent += 1;
      } catch (e) {
        lastError = e;
        await insertDelivery(db, { eventId: evt.eventId, channel: 'email', target: u.email, status: 'failed', detail: (e as Error).message }).catch(() => undefined);
      }
    }
    markPath('notification', sent ? 'db:email' : 'db:error');
    if (!sent && lastError) throw lastError;
    return { deliveryId, channels: sent ? ['email'] : [] };
  }

  async subscribeEmail(userId: string, _address: string): Promise<{ pendingConfirmation: boolean }> {
    await setNotificationPrefs(need(this.deps, 'db', 'DbNotifier'), userId, { emailEnabled: true });
    return { pendingConfirmation: false };
  }

  async unsubscribe(userId: string): Promise<void> {
    await setNotificationPrefs(need(this.deps, 'db', 'DbNotifier'), userId, { emailEnabled: false });
  }

  async probe(_opts?: { deep?: boolean }): Promise<ProbeResult> {
    const db = need(this.deps, 'db', 'DbNotifier');
    try {
      const subscribers = countOf(await db('notification_prefs').where({ email_enabled: true }).count({ count: '*' }).first());
      return {
        status: 'ok',
        detail: `站内信 + 逐个调用 EmailPort（${subscribers} 人开启了邮件通知）`,
        data: { emailSubscribers: subscribers },
      };
    } catch (e) {
      return { status: 'error', detail: `notification_prefs 表不可读：${(e as Error).message}` };
    }
  }
}
