// backend/src/jobs/notify.ts —— 本组（照片、社交、日报）发出通知事件的统一入口（F10：评论通知照片主人；photo.blocked；report.ready）
//
// 交给核心服务 services/notifications.ts 的 notify()：先写站内信（event_id 幂等；audience=admin 时给每个管理员各写一行），
// 再入队 notify.fanout，由 NotifierPort.publish(evt) 完成站外扇出（04#notification 第 1 节）。
// 通知是非权威链路：任何失败只记日志，不影响照片、点赞、评论等主流程。
import type { Knex } from 'knex';
import { isNotImplemented } from '../errors.js';
import type { Logger } from '../ports/logger.js';
import type { NotificationEvent, NotifierPort } from '../ports/notifier.js';
import type { QueuePort } from '../ports/queue.js';
import { notify } from '../services/notifications.js';

export interface NotifyDeps { db: Knex; queue: QueuePort; notifier?: NotifierPort; logger?: Logger }

/** NotifierPort 不可用时的替身：只写站内信，不做站外扇出 */
const NO_FANOUT = {
  meta: { module: 'notification', driver: 'db', awsService: null, authoritative: false },
  probe: async () => ({ status: 'ok' as const, detail: '' }),
  publish: async () => ({ deliveryId: '', channels: [] }),
  subscribeEmail: async () => ({ pendingConfirmation: false }),
  unsubscribe: async () => undefined,
} satisfies NotifierPort;

/** 发出一个通知事件。不抛异常 */
export async function emitNotification(d: NotifyDeps, evt: NotificationEvent): Promise<void> {
  try {
    await notify({ db: d.db, notifier: d.notifier ?? NO_FANOUT, queue: d.queue, ...(d.logger ? { logger: d.logger } : {}) }, evt);
  } catch (e) {
    if (!isNotImplemented(e)) d.logger?.warn('notification.emit_failed', { eventId: evt.eventId, type: evt.type, error: (e as Error)?.message ?? String(e) });
  }
}
