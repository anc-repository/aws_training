// backend/src/adapters/notification/inbox.ts —— 收件队列（SNS → SQS，原始消息传递）的消息处理（04#notification 第 2 节“收件队列消费”）
//
// 每条消息：
//   1. 写一行 notification_deliveries（channel=sqs-copy, target=inbox），让 /lab 与 /api/admin/notifications/deliveries
//      看到“一次 Publish 产生了几份投递”；同一 eventId 只记一次（至少一次投递、多实例竞争消费时幂等）。
//   2. origin≠ec2 的事件（social-api 的 lambda 集成直接 Publish 的评论）：Lambda 写不了 EC2 上的数据库，由 worker 代写站内信
//      （notifications.event_id 唯一，重复到达不会重复写）。origin=ec2 的事件站内信已由核心服务写好，这里不再写。
//   3. 探针消息（消息属性 probe=true，或 eventType=probe）：只记投递行，不写站内信。
import type { Knex } from 'knex';
import type { NotificationEvent } from '../../ports/notifier.js';
import { insertDelivery, insertNotification } from '../../repositories/notifications.js';
import { listAdmins } from '../../repositories/users.js';
import { adminRowEventId } from '../../services/notifications.js';
import { unwrapSnsEnvelope } from './sqs-poll.js';

export const INBOX_TARGET = 'inbox';

const EVENT_TYPES: ReadonlyArray<NotificationEvent['type']> = ['comment.created', 'like.created', 'photo.blocked', 'report.ready'];

export type InboxMessage =
  | { kind: 'event'; event: NotificationEvent }
  | { kind: 'probe'; eventId: string }
  | { kind: 'invalid'; reason: string };

type Attrs = Record<string, { StringValue?: string } | undefined> | undefined;

/** 解析收件队列的一条消息（消息体是发布时 Message 的 sqs 键，也接受未开原始消息传递时的 SNS 信封） */
export function parseInboxMessage(body: string | undefined, attributes?: Attrs): InboxMessage {
  const probeAttr = attributes?.probe?.StringValue === 'true';
  const v = unwrapSnsEnvelope(body) as Partial<NotificationEvent> & { eventType?: string; probe?: unknown } | undefined;
  if (!v || typeof v !== 'object') return { kind: 'invalid', reason: '消息体不是 JSON' };
  const eventId = typeof v.eventId === 'string' ? v.eventId : attributes?.eventId?.StringValue;
  if (probeAttr || v.probe === true || v.eventType === 'probe' || (v.type as string | undefined) === 'probe') {
    return eventId ? { kind: 'probe', eventId } : { kind: 'invalid', reason: '探针消息缺少 eventId' };
  }
  if (!eventId || eventId.length > 64) return { kind: 'invalid', reason: 'eventId 缺失或过长' };
  if (!v.type || !EVENT_TYPES.includes(v.type)) return { kind: 'invalid', reason: `未知事件类型 ${String(v.type)}` };
  if (v.audience !== 'user' && v.audience !== 'admin') return { kind: 'invalid', reason: 'audience 必须是 user 或 admin' };
  if (typeof v.title !== 'string' || typeof v.body !== 'string') return { kind: 'invalid', reason: '缺少 title / body' };
  const recipient = typeof v.recipientUserId === 'string' ? v.recipientUserId : '';
  if (v.audience === 'user' && !recipient) return { kind: 'invalid', reason: 'audience=user 时必须有 recipientUserId' };
  return {
    kind: 'event',
    event: {
      eventId, type: v.type, audience: v.audience, origin: v.origin === 'lambda' ? 'lambda' : 'ec2', recipientUserId: recipient,
      title: v.title, body: v.body, ...(typeof v.link === 'string' ? { link: v.link } : {}),
      ...(v.data && typeof v.data === 'object' ? { data: v.data as Record<string, string> } : {}),
    },
  };
}

export interface InboxOutcome {
  /** 本次新记下的 sqs-copy 投递（false = 同一 eventId 已经记过） */
  recorded: boolean;
  /** 代写的站内信行数（只有 origin≠ec2） */
  wroteNotifications: number;
}

async function alreadyRecorded(db: Knex, eventId: string): Promise<boolean> {
  return Boolean(await db('notification_deliveries').where({ event_id: eventId, channel: 'sqs-copy' }).first('id'));
}

/** 处理一条已解析的消息；invalid 由调用方决定（不删除，交给 DLQ） */
export async function handleInboxMessage(db: Knex, msg: InboxMessage, detail?: string): Promise<InboxOutcome> {
  if (msg.kind === 'invalid') throw new Error(`收件队列消息无效：${msg.reason}`);
  const eventId = msg.kind === 'probe' ? msg.eventId : msg.event.eventId;
  let wrote = 0;
  if (msg.kind === 'event' && msg.event.origin !== 'ec2') {
    const e = msg.event;
    const data = e.data ? { ...e.data } : null;
    const recipients = e.audience === 'admin'
      ? (await listAdmins(db)).map((a) => ({ userId: a.id, rowEventId: adminRowEventId(e.eventId, a.id) }))
      : [{ userId: e.recipientUserId, rowEventId: e.eventId }];
    for (const r of recipients) {
      const res = await insertNotification(db, {
        eventId: r.rowEventId, userId: r.userId, type: e.type, title: e.title, body: e.body, link: e.link ?? null, data,
      });
      if (res.created) wrote += 1;
    }
  }
  if (await alreadyRecorded(db, eventId)) return { recorded: false, wroteNotifications: wrote };
  await insertDelivery(db, {
    eventId, channel: 'sqs-copy', target: INBOX_TARGET, status: 'sent',
    detail: [msg.kind === 'probe' ? 'probe' : `${msg.event.type} origin=${msg.event.origin}`, detail].filter(Boolean).join(' · '),
  });
  return { recorded: true, wroteNotifications: wrote };
}
