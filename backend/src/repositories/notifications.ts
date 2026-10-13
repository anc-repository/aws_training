// backend/src/repositories/notifications.ts —— 站内信（notifications）、通知设置（notification_prefs）、
// 站外投递记录（notification_deliveries）（F10；04#notification 第 1 节）
import { randomUUID } from 'node:crypto';
import type { Knex } from 'knex';
import { boolIn, countOf, insertIgnore, jsonIn, jsonOut, nowIso } from '../db/dialect.js';
import { decodeCursor, encodeCursor } from './users.js';

type Db = Knex | Knex.Transaction;

export interface NotificationRow {
  id: string;
  event_id: string;
  user_id: string;
  type: string;
  title: string;
  body: string;
  link: string | null;
  data: unknown;
  read_at: string | null;
  created_at: string;
}

/** 幂等写入（event_id 唯一）：返回 created=false 表示同一事件已经写过 */
export async function insertNotification(db: Db, input: {
  eventId: string; userId: string; type: string; title: string; body: string; link?: string | null; data?: Record<string, unknown> | null;
}): Promise<{ created: boolean; id: string }> {
  const id = randomUUID();
  await insertIgnore(db, 'notifications', {
    id, event_id: input.eventId, user_id: input.userId, type: input.type, title: input.title.slice(0, 200), body: input.body,
    link: input.link ?? null, data: jsonOut(input.data ?? null), read_at: null, created_at: nowIso(),
  }, ['event_id']);
  // insertIgnore 的返回值在 better-sqlite3 下不可靠（返回 lastInsertRowid），按 event_id 回读并比较 id
  const existing = (await db('notifications').where({ event_id: input.eventId }).first('id')) as { id: string } | undefined;
  return { created: existing?.id === id, id: existing?.id ?? id };
}

export async function listNotifications(db: Db, userId: string, opts: { limit?: number; cursor?: string; unreadOnly?: boolean } = {}): Promise<{ items: NotificationRow[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  const q = db('notifications').where({ user_id: userId });
  if (opts.unreadOnly) q.whereNull('read_at');
  const cur = decodeCursor(opts.cursor);
  if (cur) q.andWhere((w) => w.where('created_at', '<', cur.ts).orWhere((w2) => w2.where('created_at', '=', cur.ts).andWhere('id', '<', cur.id)));
  const rows = (await q.orderBy([{ column: 'created_at', order: 'desc' }, { column: 'id', order: 'desc' }]).limit(limit + 1)) as NotificationRow[];
  const items = rows.slice(0, limit).map((r) => ({ ...r, data: jsonIn(r.data, null) }));
  const last = items[items.length - 1];
  return { items, nextCursor: rows.length > limit && last ? encodeCursor(last.created_at, last.id) : null };
}

export async function countUnread(db: Db, userId: string): Promise<number> {
  return countOf(await db('notifications').where({ user_id: userId }).whereNull('read_at').count({ count: '*' }).first());
}

/** 只能标记自己的站内信；返回是否找到 */
export async function markNotificationRead(db: Db, userId: string, id: string): Promise<boolean> {
  const row = await db('notifications').where({ id, user_id: userId }).first('id', 'read_at');
  if (!row) return false;
  await db('notifications').where({ id, user_id: userId }).whereNull('read_at').update({ read_at: nowIso() });
  return true;
}

export async function markAllNotificationsRead(db: Db, userId: string): Promise<number> {
  return Number(await db('notifications').where({ user_id: userId }).whereNull('read_at').update({ read_at: nowIso() }));
}

// ------------------------------------------------------------------------------------------------
// notification_prefs
// ------------------------------------------------------------------------------------------------

export interface NotificationPrefsRow {
  user_id: string;
  email_enabled: boolean | number;
  sns_subscription_arn: string | null;
  sns_status: string | null;
  updated_at: string;
}

export async function getNotificationPrefs(db: Db, userId: string): Promise<{ emailEnabled: boolean; snsSubscriptionArn: string | null; snsStatus: string | null }> {
  const row = (await db('notification_prefs').where({ user_id: userId }).first()) as NotificationPrefsRow | undefined;
  return {
    emailEnabled: row ? boolIn(row.email_enabled) : false,
    snsSubscriptionArn: row?.sns_subscription_arn ?? null,
    snsStatus: row?.sns_status ?? null,
  };
}

export async function setNotificationPrefs(db: Db, userId: string, patch: { emailEnabled?: boolean; snsSubscriptionArn?: string | null; snsStatus?: string | null }): Promise<void> {
  const existing = await db('notification_prefs').where({ user_id: userId }).first('user_id');
  const values: Record<string, unknown> = { updated_at: nowIso() };
  if (patch.emailEnabled !== undefined) values.email_enabled = patch.emailEnabled;
  if (patch.snsSubscriptionArn !== undefined) values.sns_subscription_arn = patch.snsSubscriptionArn;
  if (patch.snsStatus !== undefined) values.sns_status = patch.snsStatus;
  if (existing) await db('notification_prefs').where({ user_id: userId }).update(values);
  else await db('notification_prefs').insert({ user_id: userId, email_enabled: false, sns_subscription_arn: null, sns_status: null, ...values });
}

// ------------------------------------------------------------------------------------------------
// notification_deliveries
// ------------------------------------------------------------------------------------------------

export interface DeliveryRow {
  id: string;
  event_id: string;
  channel: string;
  target: string | null;
  status: string;
  detail: string | null;
  at: string;
}

export async function insertDelivery(db: Db, input: { eventId: string; channel: 'email' | 'sns' | 'sqs-copy'; target?: string | null; status: string; detail?: string | null }): Promise<DeliveryRow> {
  const row: DeliveryRow = {
    id: randomUUID(), event_id: input.eventId, channel: input.channel, target: input.target ?? null, status: input.status,
    detail: input.detail ? input.detail.slice(0, 2000) : null, at: nowIso(),
  };
  await db('notification_deliveries').insert(row);
  return row;
}

/** 至少一次投递的幂等判断：同一事件、渠道、目标已经成功投递过 */
export async function deliveryExists(db: Db, eventId: string, channel: string, target: string): Promise<boolean> {
  const row = await db('notification_deliveries').where({ event_id: eventId, channel, target }).whereIn('status', ['sent', 'stored']).first('id');
  return Boolean(row);
}

export async function listDeliveries(db: Db, opts: { eventId?: string; limit?: number } = {}): Promise<DeliveryRow[]> {
  const q = db('notification_deliveries').orderBy([{ column: 'at', order: 'desc' }, { column: 'id', order: 'desc' }])
    .limit(Math.min(Math.max(opts.limit ?? 50, 1), 500));
  if (opts.eventId) q.where({ event_id: opts.eventId });
  return (await q) as DeliveryRow[];
}
