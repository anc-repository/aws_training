// backend/src/repositories/outbox.ts —— outbox_emails 表（EmailPort 的发送记录；04#email 第 1 节）
//
// outbox 档：每封邮件一个 .eml（OUTBOX_DIR/<yyyy-mm-dd>/<messageId>.eml，eml_path 存相对 OUTBOX_DIR 的逻辑路径）+ 一行记录；
// ses 档同样写记录（不存正文）。/admin/outbox 看全部；/me/outbox 只看收件人是本人的（不含 password-reset）。
import { randomUUID } from 'node:crypto';
import type { Knex } from 'knex';
import { countOf, dialectOf, jsonIn, jsonOut, nowIso } from '../db/dialect.js';
import { decodeCursor, encodeCursor } from './users.js';

type Db = Knex | Knex.Transaction;

export interface OutboxEmailRow {
  id: string;
  message_id: string;
  to_addrs: string[];
  subject: string;
  category: string;
  transport: string;
  status: string;
  delivery_status: string;
  provider_message_id: string | null;
  error: string | null;
  user_id: string | null;
  eml_path: string | null;
  created_at: string;
  sent_at: string | null;
}

/** jsonb 列按文本比较（PostgreSQL 需要显式转成 text；SQLite 本来就是文本） */
function toAddrsText(db: Db): string {
  return dialectOf(db as Knex) === 'postgres' ? 'lower(to_addrs::text)' : 'lower(to_addrs)';
}

function mapRow(r: Record<string, unknown>): OutboxEmailRow {
  return { ...(r as unknown as OutboxEmailRow), to_addrs: jsonIn<string[]>(r.to_addrs, []) ?? [] };
}

export async function insertOutboxEmail(db: Db, input: {
  messageId: string; to: string[]; subject: string; category: string; transport: 'outbox' | 'ses'; status: 'queued' | 'sent' | 'failed';
  userId?: string | null; emlPath?: string | null; error?: string | null; providerMessageId?: string | null; sentAt?: string | null;
}): Promise<OutboxEmailRow> {
  const now = nowIso();
  const row = {
    id: randomUUID(), message_id: input.messageId, to_addrs: jsonOut(input.to), subject: input.subject.slice(0, 300),
    category: input.category, transport: input.transport, status: input.status, delivery_status: 'none',
    provider_message_id: input.providerMessageId ?? null, error: input.error ?? null, user_id: input.userId ?? null,
    eml_path: input.emlPath ?? null, created_at: now, sent_at: input.sentAt ?? (input.status === 'sent' ? now : null),
  };
  await db('outbox_emails').insert(row);
  return mapRow(row);
}

export interface OutboxFilter { to?: string; category?: string; status?: string; userId?: string; limit?: number; cursor?: string }

export async function listOutbox(db: Db, f: OutboxFilter = {}): Promise<{ items: OutboxEmailRow[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(f.limit ?? 50, 1), 200);
  const q = db('outbox_emails').select('*');
  if (f.category) q.where({ category: f.category });
  if (f.status) q.where({ status: f.status });
  if (f.userId) q.where({ user_id: f.userId });
  if (f.to) q.whereRaw(`${toAddrsText(db)} like ?`, [`%${f.to.trim().toLowerCase()}%`]);
  const cur = decodeCursor(f.cursor);
  if (cur) q.andWhere((w) => w.where('created_at', '<', cur.ts).orWhere((w2) => w2.where('created_at', '=', cur.ts).andWhere('id', '<', cur.id)));
  const rows = (await q.orderBy([{ column: 'created_at', order: 'desc' }, { column: 'id', order: 'desc' }]).limit(limit + 1)) as Array<Record<string, unknown>>;
  const items = rows.slice(0, limit).map(mapRow);
  const last = items[items.length - 1];
  return { items, nextCursor: rows.length > limit && last ? encodeCursor(last.created_at, last.id) : null };
}

export async function findOutboxEmail(db: Db, id: string): Promise<OutboxEmailRow | undefined> {
  const row = (await db('outbox_emails').where({ id }).orWhere({ message_id: id }).first()) as Record<string, unknown> | undefined;
  return row ? mapRow(row) : undefined;
}

/** 收件人是否为本人：user_id 等于本人，或 to_addrs 只含本人邮箱（04#email /me/outbox） */
export function isOwnEmail(row: Pick<OutboxEmailRow, 'user_id' | 'to_addrs'>, who: { userId: string; email: string }): boolean {
  if (row.user_id && row.user_id === who.userId) return true;
  const email = who.email.trim().toLowerCase();
  return row.to_addrs.length > 0 && row.to_addrs.every((a) => a.trim().toLowerCase() === email);
}

export const SELF_PREVIEW_EXCLUDED_CATEGORIES: readonly string[] = ['password-reset'];

/** /me/outbox：只返回发给本人的邮件，不含 password-reset 类别 */
export async function listOutboxForRecipient(db: Db, who: { userId: string; email: string }, opts: { limit?: number; cursor?: string } = {}): Promise<{ items: OutboxEmailRow[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  const email = who.email.trim().toLowerCase();
  const q = db('outbox_emails').select('*')
    .whereNotIn('category', [...SELF_PREVIEW_EXCLUDED_CATEGORIES])
    .andWhere((w) => w.where({ user_id: who.userId }).orWhere((w2) => w2.whereNull('user_id').andWhereRaw(`${toAddrsText(db)} like ?`, [`%${email}%`])));
  const cur = decodeCursor(opts.cursor);
  if (cur) q.andWhere((w) => w.where('created_at', '<', cur.ts).orWhere((w2) => w2.where('created_at', '=', cur.ts).andWhere('id', '<', cur.id)));
  const rows = (await q.orderBy([{ column: 'created_at', order: 'desc' }, { column: 'id', order: 'desc' }]).limit(limit + 1)) as Array<Record<string, unknown>>;
  const filtered = rows.map(mapRow).filter((r) => isOwnEmail(r, who));
  const items = filtered.slice(0, limit);
  const last = items[items.length - 1];
  return { items, nextCursor: rows.length > limit && last ? encodeCursor(last.created_at, last.id) : null };
}

export async function findOutboxForRecipient(db: Db, id: string, who: { userId: string; email: string }): Promise<OutboxEmailRow | undefined> {
  const row = await findOutboxEmail(db, id);
  if (!row || SELF_PREVIEW_EXCLUDED_CATEGORIES.includes(row.category) || !isOwnEmail(row, who)) return undefined;
  return row;
}

export async function updateOutboxStatus(db: Db, id: string, patch: { status?: string; deliveryStatus?: string; error?: string | null; sentAt?: string | null }): Promise<void> {
  const values: Record<string, unknown> = {};
  if (patch.status) values.status = patch.status;
  if (patch.deliveryStatus) values.delivery_status = patch.deliveryStatus;
  if (patch.error !== undefined) values.error = patch.error;
  if (patch.sentAt !== undefined) values.sent_at = patch.sentAt;
  if (Object.keys(values).length) await db('outbox_emails').where({ id }).update(values);
}

export async function countOutbox(db: Db): Promise<number> {
  return countOf(await db('outbox_emails').count({ count: '*' }).first());
}

/** outbox.retention：删除早于 before 的记录，返回被删记录的 eml_path（由调用方删除文件） */
export async function deleteOutboxBefore(db: Db, before: string): Promise<string[]> {
  const rows = (await db('outbox_emails').where('created_at', '<', before).select('eml_path')) as Array<{ eml_path: string | null }>;
  await db('outbox_emails').where('created_at', '<', before).del();
  return rows.map((r) => r.eml_path).filter((p): p is string => Boolean(p));
}
