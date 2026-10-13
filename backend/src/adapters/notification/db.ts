// backend/src/adapters/notification/db.ts —— NotifierPort 的 `db` 驱动（本地实现）
// 站外渠道：按 notification_prefs 调用 EmailPort；记录 notification_deliveries
// 脚手架桩：方法抛出 NotImplementedError（HTTP 层映射为 501）。由「L0 本地实现者」填充。
import type { AdapterDeps } from '../types.js';
import type { AdapterMeta, ProbeResult } from '../../ports/common.js';
import type { NotificationEvent, NotifierPort } from '../../ports/notifier.js';
import { notImplemented } from '../../errors.js';

export class DbNotifier implements NotifierPort {
  readonly meta: AdapterMeta = { module: 'notification', driver: 'db', awsService: null, authoritative: false };

  constructor(protected readonly deps: AdapterDeps) {}

  async probe(_opts?: { deep?: boolean }): Promise<ProbeResult> {
    throw notImplemented('DbNotifier', 'probe', 'notification');
  }

  async publish(_evt: NotificationEvent): Promise<{ deliveryId: string; channels: Array<'email' | 'sns'> }> {
    throw notImplemented('DbNotifier', 'publish', 'notification');
  }

  async subscribeEmail(_userId: string, _address: string): Promise<{ pendingConfirmation: boolean }> {
    throw notImplemented('DbNotifier', 'subscribeEmail', 'notification');
  }

  async unsubscribe(_userId: string): Promise<void> {
    throw notImplemented('DbNotifier', 'unsubscribe', 'notification');
  }
}
