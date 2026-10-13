// backend/src/ports/email.ts （总纲 §4.2，照录）
import type { Adapter } from './common.js';

export interface EmailMessage {
  to: string[]; subject: string; text: string; html?: string;
  category: 'verification' | 'password-reset' | 'notification' | 'report' | 'system';
  tags?: Record<string, string>;
}
export interface EmailPort extends Adapter {
  send(msg: EmailMessage): Promise<{ messageId: string; transport: 'outbox' | 'ses'; delivered: boolean }>;
  /** outbox：管理后台查看全部“发出”的邮件（含正文）；ses：只返回发送记录，不含正文 */
  listRecent(limit: number): Promise<Array<{ messageId: string; to: string[]; subject: string; category: string; at: string; status: string }>>;
}
