// backend/src/services/notifications.ts —— 站内信（核心服务，与 NOTIFY_DRIVER 无关）+ 站外扇出入队（F10；04#notification 第 1 节）
//
// notify(evt)：
//   1. 写 notifications 表（event_id 幂等；audience=admin 时给每个管理员各写一行，event_id 由 eventId + userId 派生）；
//   2. 入队 notify.fanout（QUEUE_DRIVER=sync 时在请求内执行），由 fanout handler 调用 NotifierPort.publish(evt) 完成站外扇出。
//      入队本身失败（例如队列 handler 尚未绑定）时直接调用 NotifierPort 并告警——通知是非权威端口，站内信已经写好，不能因此让业务请求失败。
// 事件类型：comment.created、like.created、photo.blocked（tagging）、report.ready（日报）。
import { createHash } from 'node:crypto';
import type { Knex } from 'knex';
import { ulid } from 'ulid';
import type { Logger } from '../ports/logger.js';
import type { NotificationEvent, NotifierPort } from '../ports/notifier.js';
import type { JobEnvelope, JobHandler, QueuePort } from '../ports/queue.js';
import { insertNotification, type NotificationRow } from '../repositories/notifications.js';
import type { OutboxEmailRow } from '../repositories/outbox.js';
import { listAdmins } from '../repositories/users.js';
import { jsonIn } from '../db/dialect.js';

export interface NotifyDeps {
  db: Knex;
  notifier: NotifierPort;
  queue?: QueuePort;
  logger?: Pick<Logger, 'warn' | 'error' | 'info'>;
}

export type NotifyInput = Omit<NotificationEvent, 'eventId' | 'origin'> & { eventId?: string; origin?: NotificationEvent['origin'] };

export const NOTIFY_FANOUT_JOB = 'notify.fanout' as const;

/** 管理员广播的每行 event_id（notifications.event_id 唯一，长度 ≤ 64） */
export function adminRowEventId(eventId: string, userId: string): string {
  return `a:${createHash('sha256').update(`${eventId}|${userId}`).digest('hex').slice(0, 40)}`;
}

export async function notify(deps: NotifyDeps, input: NotifyInput): Promise<{ event: NotificationEvent; created: number }> {
  const event: NotificationEvent = { ...input, eventId: input.eventId ?? ulid(), origin: input.origin ?? 'ec2' };
  let created = 0;
  const data = event.data ? { ...event.data } : null;
  if (event.audience === 'admin') {
    for (const admin of await listAdmins(deps.db)) {
      const r = await insertNotification(deps.db, {
        eventId: adminRowEventId(event.eventId, admin.id), userId: admin.id, type: event.type, title: event.title, body: event.body,
        link: event.link ?? null, data,
      });
      if (r.created) created += 1;
    }
  } else {
    const r = await insertNotification(deps.db, {
      eventId: event.eventId, userId: event.recipientUserId, type: event.type, title: event.title, body: event.body, link: event.link ?? null, data,
    });
    if (r.created) created += 1;
  }
  if (!created) return { event, created };                  // 同一事件重复到达：站内信与扇出都只做一次
  try {
    if (!deps.queue) throw new Error('未提供 QueuePort');
    await deps.queue.enqueue(NOTIFY_FANOUT_JOB, event, { dedupKey: `notify:${event.eventId}` });
  } catch (e) {
    deps.logger?.warn('notify.fanout enqueue failed; publishing directly', { eventId: event.eventId, error: (e as Error).message });
    await fanout(deps, event);
  }
  return { event, created };
}

/** notify.fanout 任务本体：站外扇出失败只记日志（非权威端口，站内信不受影响） */
export async function fanout(deps: Pick<NotifyDeps, 'notifier' | 'logger'>, event: NotificationEvent): Promise<void> {
  try {
    await deps.notifier.publish(event);
  } catch (e) {
    deps.logger?.warn('notification fan-out failed', { eventId: event.eventId, type: event.type, error: (e as Error).message });
  }
}

/** jobs/index.ts 的 bindJobs() 用它绑定 notify.fanout */
export function notifyFanoutHandler(deps: Pick<NotifyDeps, 'notifier' | 'logger'>): JobHandler<NotificationEvent> {
  return async (job: JobEnvelope<NotificationEvent>) => fanout(deps, job.payload);
}

/** 站内信的对外 JSON 形状（frontend/src/api/types.ts 的 NotificationItem） */
export function toNotificationItem(r: NotificationRow): {
  id: string; type: string; title: string; body: string; link: string | null; data: Record<string, unknown> | null; readAt: string | null; createdAt: string;
} {
  return {
    id: r.id, type: r.type, title: r.title, body: r.body, link: r.link, data: jsonIn<Record<string, unknown>>(r.data, null),
    readAt: r.read_at, createdAt: r.created_at,
  };
}

/** outbox_emails 行的对外 JSON 形状（frontend/src/api/types.ts 的 OutboxEmailSummary；/admin/outbox 与 /me/outbox 共用） */
export function toOutboxSummary(r: OutboxEmailRow): {
  id: string; messageId: string; to: string[]; subject: string; category: string; transport: string; status: string; deliveryStatus: string;
  error: string | null; userId: string | null; createdAt: string; sentAt: string | null;
} {
  return {
    id: r.id, messageId: r.message_id, to: r.to_addrs, subject: r.subject, category: r.category, transport: r.transport, status: r.status,
    deliveryStatus: r.delivery_status, error: r.error, userId: r.user_id, createdAt: r.created_at, sentAt: r.sent_at,
  };
}
