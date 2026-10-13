// backend/src/adapters/notification/sns.ts —— NotifierPort 的 `sns` 驱动（Amazon SNS）
// 本轮未实现
// 脚手架桩：方法抛出 NotImplementedError（HTTP 层映射为 501）。由「后续版本（本轮 MVP 不实现；配置该驱动会被 config/implemented.ts 以 CFG-001 拒绝）」填充。
import type { AdapterDeps } from '../types.js';
import type { AdapterMeta, ProbeResult } from '../../ports/common.js';
import type { NotificationEvent, NotifierPort } from '../../ports/notifier.js';
import { notImplemented } from '../../errors.js';

export class SnsNotifier implements NotifierPort {
  readonly meta: AdapterMeta = { module: 'notification', driver: 'sns', awsService: 'Amazon SNS', authoritative: false };

  constructor(protected readonly deps: AdapterDeps) {}

  async probe(_opts?: { deep?: boolean }): Promise<ProbeResult> {
    throw notImplemented('SnsNotifier', 'probe', 'notification');
  }

  async publish(_evt: NotificationEvent): Promise<{ deliveryId: string; channels: Array<'email' | 'sns'> }> {
    throw notImplemented('SnsNotifier', 'publish', 'notification');
  }

  async subscribeEmail(_userId: string, _address: string): Promise<{ pendingConfirmation: boolean }> {
    throw notImplemented('SnsNotifier', 'subscribeEmail', 'notification');
  }

  async unsubscribe(_userId: string): Promise<void> {
    throw notImplemented('SnsNotifier', 'unsubscribe', 'notification');
  }
}
