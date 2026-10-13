// backend/src/adapters/email/ses.ts —— EmailPort 的 `ses` 驱动（Amazon SES）
// 本轮未实现
// 脚手架桩：方法抛出 NotImplementedError（HTTP 层映射为 501）。由「后续版本（本轮 MVP 不实现；配置该驱动会被 config/implemented.ts 以 CFG-001 拒绝）」填充。
import type { AdapterDeps } from '../types.js';
import type { AdapterMeta, ProbeResult } from '../../ports/common.js';
import type { EmailMessage, EmailPort } from '../../ports/email.js';
import { notImplemented } from '../../errors.js';

export class SesEmail implements EmailPort {
  readonly meta: AdapterMeta = { module: 'email', driver: 'ses', awsService: 'Amazon SES', authoritative: false };

  constructor(protected readonly deps: AdapterDeps) {}

  async probe(_opts?: { deep?: boolean }): Promise<ProbeResult> {
    throw notImplemented('SesEmail', 'probe', 'email');
  }

  async send(_msg: EmailMessage): Promise<{ messageId: string; transport: 'outbox' | 'ses'; delivered: boolean }> {
    throw notImplemented('SesEmail', 'send', 'email');
  }

  async listRecent(_limit: number): Promise<Array<{ messageId: string; to: string[]; subject: string; category: string; at: string; status: string }>> {
    throw notImplemented('SesEmail', 'listRecent', 'email');
  }
}
