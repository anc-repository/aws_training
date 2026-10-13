// backend/src/adapters/email/outbox.ts —— EmailPort 的 `outbox` 驱动（本地实现）
// .eml 写入 OUTBOX_DIR/<yyyy-mm-dd>/ + outbox_emails 表；/admin/outbox、/me/outbox 查看
// 脚手架桩：方法抛出 NotImplementedError（HTTP 层映射为 501）。由「L0 本地实现者」填充。
import type { AdapterDeps } from '../types.js';
import type { AdapterMeta, ProbeResult } from '../../ports/common.js';
import type { EmailMessage, EmailPort } from '../../ports/email.js';
import { notImplemented } from '../../errors.js';

export class OutboxEmail implements EmailPort {
  readonly meta: AdapterMeta = { module: 'email', driver: 'outbox', awsService: null, authoritative: false };

  constructor(protected readonly deps: AdapterDeps) {}

  async probe(_opts?: { deep?: boolean }): Promise<ProbeResult> {
    throw notImplemented('OutboxEmail', 'probe', 'email');
  }

  async send(_msg: EmailMessage): Promise<{ messageId: string; transport: 'outbox' | 'ses'; delivered: boolean }> {
    throw notImplemented('OutboxEmail', 'send', 'email');
  }

  async listRecent(_limit: number): Promise<Array<{ messageId: string; to: string[]; subject: string; category: string; at: string; status: string }>> {
    throw notImplemented('OutboxEmail', 'listRecent', 'email');
  }
}
