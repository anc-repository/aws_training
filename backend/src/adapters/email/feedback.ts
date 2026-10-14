// backend/src/adapters/email/feedback.ts —— SES 反馈事件（配置集事件目标 → SNS email-events → SQS email-feedback）的处理
// （04#email 第 2 节“反馈处理”；wave1-sns-ses）
//
//   Delivery                 → outbox_emails.delivery_status = delivered
//   Bounce（Permanent）      → bounced，并把 users.email_status 置为 bounced（之后只发 verification / password-reset）
//   Bounce（Transient 等）   → 只记录（delivered 之前记为 delayed），不改用户状态
//   Complaint                → complained，users.email_status = complained
//   Reject                   → rejected
//   DeliveryDelay            → delayed（只在还没有更“终态”的状态时）
//   Send / Open / Click / …  → 忽略
// 状态只“升级”不“降级”：complained > bounced > rejected > delivered > delayed > none（投诉一般在投递之后到达）。
// 按 SES MessageId（outbox_emails.provider_message_id）定位记录；重复事件幂等。
import type { Knex } from 'knex';
import { nowIso } from '../../db/dialect.js';
import { unwrapSnsEnvelope } from '../notification/sqs-poll.js';

export type FeedbackKind = 'delivery' | 'bounce' | 'complaint' | 'reject' | 'delay' | 'ignored';

export interface SesFeedback {
  kind: FeedbackKind;
  /** SES 的 eventType / notificationType 原文 */
  eventType: string;
  messageId?: string;
  /** Bounce 的 bounceType（Permanent / Transient / Undetermined） */
  bounceType?: string;
  /** 受影响的收件人（小写） */
  recipients: string[];
  /** 发送时的标签（EmailTags：category 等） */
  tags: Record<string, string>;
  timestamp?: string;
}

const RANK: Record<string, number> = { none: 0, delayed: 1, delivered: 2, rejected: 3, bounced: 4, complained: 5 };

interface RawEvent {
  eventType?: string;
  notificationType?: string;
  mail?: { messageId?: string; destination?: string[]; tags?: Record<string, string[]>; timestamp?: string };
  bounce?: { bounceType?: string; bouncedRecipients?: Array<{ emailAddress?: string }>; timestamp?: string };
  complaint?: { complainedRecipients?: Array<{ emailAddress?: string }>; timestamp?: string };
  delivery?: { recipients?: string[]; timestamp?: string };
  reject?: { reason?: string };
  deliveryDelay?: { delayedRecipients?: Array<{ emailAddress?: string }>; timestamp?: string };
}

const lower = (xs: Array<string | undefined>): string[] => xs.filter((x): x is string => Boolean(x)).map((x) => x.trim().toLowerCase());

/** 解析反馈队列的一条消息（原始消息传递 = SES 事件 JSON；也接受 SNS 信封）。不是 SES 事件时返回 null */
export function parseSesFeedback(body: string | undefined): SesFeedback | null {
  const v = unwrapSnsEnvelope(body) as RawEvent | undefined;
  if (!v || typeof v !== 'object') return null;
  const eventType = v.eventType ?? v.notificationType;
  if (typeof eventType !== 'string') return null;
  const tags = Object.fromEntries(Object.entries(v.mail?.tags ?? {}).map(([k, vals]) => [k, Array.isArray(vals) ? String(vals[0] ?? '') : String(vals)]));
  const base = { eventType, ...(v.mail?.messageId ? { messageId: v.mail.messageId } : {}), tags, ...(v.mail?.timestamp ? { timestamp: v.mail.timestamp } : {}) };
  switch (eventType) {
    case 'Delivery':
      return { ...base, kind: 'delivery', recipients: lower(v.delivery?.recipients ?? v.mail?.destination ?? []) };
    case 'Bounce':
      return {
        ...base, kind: 'bounce', ...(v.bounce?.bounceType ? { bounceType: v.bounce.bounceType } : {}),
        recipients: lower((v.bounce?.bouncedRecipients ?? []).map((r) => r.emailAddress)),
      };
    case 'Complaint':
      return { ...base, kind: 'complaint', recipients: lower((v.complaint?.complainedRecipients ?? []).map((r) => r.emailAddress)) };
    case 'Reject':
      return { ...base, kind: 'reject', recipients: lower(v.mail?.destination ?? []) };
    case 'DeliveryDelay':
      return { ...base, kind: 'delay', recipients: lower((v.deliveryDelay?.delayedRecipients ?? []).map((r) => r.emailAddress)) };
    default:
      return { ...base, kind: 'ignored', recipients: [] };
  }
}

/** 反馈事件 → outbox_emails.delivery_status（null = 不更新） */
export function deliveryStatusOf(f: SesFeedback): string | null {
  switch (f.kind) {
    case 'delivery': return 'delivered';
    case 'complaint': return 'complained';
    case 'reject': return 'rejected';
    case 'delay': return 'delayed';
    case 'bounce': return f.bounceType === 'Permanent' ? 'bounced' : 'delayed';
    default: return null;
  }
}

/** 反馈事件 → users.email_status（null = 不改用户状态：软退信、投递延迟只记录） */
export function userStatusOf(f: SesFeedback): 'bounced' | 'complained' | null {
  if (f.kind === 'complaint') return 'complained';
  if (f.kind === 'bounce' && f.bounceType === 'Permanent') return 'bounced';
  return null;
}

export interface FeedbackOutcome {
  kind: FeedbackKind;
  /** 更新了几行 outbox_emails */
  rows: number;
  /** 更新了几个用户的 email_status */
  users: number;
}

/** 把一条反馈应用到数据库（幂等） */
export async function applySesFeedback(db: Knex, f: SesFeedback): Promise<FeedbackOutcome> {
  const out: FeedbackOutcome = { kind: f.kind, rows: 0, users: 0 };
  const status = deliveryStatusOf(f);
  if (status && f.messageId) {
    const rows = (await db('outbox_emails').where({ provider_message_id: f.messageId }).select('id', 'delivery_status', 'error')) as Array<{
      id: string; delivery_status: string; error: string | null;
    }>;
    for (const r of rows) {
      if ((RANK[status] ?? 0) < (RANK[r.delivery_status] ?? 0)) continue;
      const patch: Record<string, unknown> = { delivery_status: status };
      if (f.kind === 'bounce' || f.kind === 'complaint' || f.kind === 'reject') {
        const note = `SES ${f.eventType}${f.bounceType ? `（${f.bounceType}）` : ''}${f.recipients.length ? `：${f.recipients.join(', ')}` : ''}`;
        if (!(r.error ?? '').includes(note)) patch.error = r.error ? `${r.error}\n${note}` : note;
      }
      if (r.delivery_status === status && !patch.error) continue;
      out.rows += Number(await db('outbox_emails').where({ id: r.id }).update(patch));
    }
  }
  const userStatus = userStatusOf(f);
  if (userStatus) {
    for (const addr of f.recipients) {
      const rank = userStatus === 'complained' ? ['ok', 'bounced'] : ['ok'];   // complained 覆盖 bounced，反之不覆盖
      out.users += Number(await db('users').whereRaw('lower(email) = ?', [addr]).whereIn('email_status', rank)
        .update({ email_status: userStatus, updated_at: nowIso() }));
    }
  }
  return out;
}
