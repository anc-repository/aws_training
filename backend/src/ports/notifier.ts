// backend/src/ports/notifier.ts （总纲 §4.2，照录）
import type { Adapter } from './common.js';

export interface NotificationEvent {
  eventId: string;                   // 幂等键
  type: 'comment.created' | 'like.created' | 'photo.blocked' | 'report.ready';
  audience: 'user' | 'admin';        // admin = 管理员广播（订阅过滤策略用 $or）
  origin: 'ec2' | 'lambda';          // lambda = social-api 的 lambda 集成写入，由 worker 代写站内信
  recipientUserId: string; title: string; body: string; link?: string;
  data?: Record<string, string>;
}
export interface NotifierPort extends Adapter {
  /** 站内信始终由核心服务写入 notifications 表；端口只负责“站外渠道”扇出 */
  publish(evt: NotificationEvent): Promise<{ deliveryId: string; channels: Array<'email' | 'sns'> }>;
  /** sns 档：创建带过滤策略 {"userId":[id]} 的邮件订阅，需要收件人确认 */
  subscribeEmail(userId: string, address: string): Promise<{ pendingConfirmation: boolean }>;
  unsubscribe(userId: string): Promise<void>;
}
