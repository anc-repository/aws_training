// backend/src/adapters/email/ses.ts —— EmailPort 的 `ses` 驱动（Amazon SES v2，04#email 第 2 节；wave1-sns-ses）
//
// 发信：与 outbox 驱动同一份 MIME（outbox.ts 的 buildMime，X-CloudAlbum-Transport: ses），经 SendEmail(Content.Raw) 发出；
//   FromEmailAddress=EMAIL_FROM、ConfigurationSetName=SES_CONFIGURATION_SET、EmailTags 带 category（配置集的 CloudWatch 事件目标
//   以它为维度）。每封仍写一行 outbox_emails（transport=ses、provider_message_id=SES MessageId，不存正文），/admin/outbox 成为统一的
//   发送日志；listRecent() 不返回正文。
// 发送前：
//   1. 保留域名（06 PM-46）：example.com / .test 等不调用 SES，交给本机 outbox 并标注“保留域名，未发送”，路径段 email=outbox:reserved；
//   2. 抑制：users.email_status 为 bounced / complained 的地址只发 verification、password-reset，其他类别跳过（ses:suppressed）；
//   3. 限速：进程内按 EMAIL_SEND_RATE_PER_SEC 排队（不超过账号的最大发送速率）。
// 失败（非权威端口）：不抛出，记一行 status=failed（/admin/outbox 标红），路径段 ses:rejected（MessageRejected，沙盒期发给未验证地址）
//   或 ses:error；EMAIL_SANDBOX_POLICY=outbox 时被拒的邮件改写进本机 outbox（同样标注“未真正发出”）。从不悄悄改写成“已发送”。
// 反馈（worker，consume()）：长轮询 SES_FEEDBACK_QUEUE_URL，feedback.ts 更新 delivery_status 与 users.email_status。
// 探针：GetAccount（SendingEnabled、ProductionAccessEnabled、SendQuota）+ GetEmailIdentity（验证与 DKIM）+ 反馈队列 / DLQ 深度，
//   经 withAwsRetry；沙盒 → degraded，detail 以“沙盒：只能发给已验证地址 · 今日已发 n / 上限 m”开头（上限取自 GetAccount）。
//   深度探针另外向 SES 邮箱模拟器 success@simulator.amazonses.com 发一封探针邮件（每 10 分钟最多一次），报告上一封是否已回流为“已投递”。
import { performance } from 'node:perf_hooks';
import type { GetAccountCommandOutput, GetEmailIdentityCommandOutput, SESv2Client } from '@aws-sdk/client-sesv2';
import type { QueueAttributeName } from '@aws-sdk/client-sqs';
import { ulid } from 'ulid';
import { markPath } from '../../observability/request-context.js';
import type { AdapterMeta, ProbeResult } from '../../ports/common.js';
import type { EmailMessage, EmailPort } from '../../ports/email.js';
import { insertOutboxEmail, listOutbox, type OutboxEmailRow } from '../../repositories/outbox.js';
import { findUserByEmail } from '../../repositories/users.js';
import {
  AwsCredentialsUnavailableError, awsErrorName, describeAwsError, isAwsAccessDenied, isAwsNotFound, isAwsTransient, loadAwsPackage, withAwsRetry,
} from '../aws/clients.js';
import { newPollStats, pollQueue, queueUrlFromArn, sleep, type PollStats } from '../notification/sqs-poll.js';
import type { AdapterDeps } from '../types.js';
import { need } from '../types.js';
import { applySesFeedback, parseSesFeedback } from './feedback.js';
import { buildMime, OutboxEmail, type ParsedEml } from './outbox.js';
import { isReservedAddress, RESERVED_NOTE } from './reserved.js';

type SesConfig = Extract<AdapterDeps['cfg']['email'], { EMAIL_DRIVER: 'ses' }>;
type SesSdk = typeof import('@aws-sdk/client-sesv2');

/** 收件人被抑制（bounced / complained）时仍然发送的必要类别 */
export const ESSENTIAL_CATEGORIES: ReadonlySet<EmailMessage['category']> = new Set(['verification', 'password-reset']);

export const SIMULATOR_SUCCESS = 'success@simulator.amazonses.com';

const WINDOW_MS = 5 * 60_000;
const PROBE_MAIL_MIN_INTERVAL_MS = 10 * 60_000;

/** SES 标签的名称与值只允许 ASCII 字母、数字、下划线、连字符（最长 256） */
export function sesTag(s: string): string {
  return s.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 256) || '_';
}

export function emailTagsOf(msg: Pick<EmailMessage, 'category' | 'tags'>): Array<{ Name: string; Value: string }> {
  const extra = Object.entries(msg.tags ?? {}).filter(([k]) => k !== 'category').slice(0, 4).map(([k, v]) => ({ Name: sesTag(k), Value: sesTag(String(v)) }));
  return [{ Name: 'category', Value: sesTag(msg.category) }, ...extra];
}

export class SesEmail implements EmailPort {
  readonly meta: AdapterMeta = { module: 'email', driver: 'ses', awsService: 'Amazon SES', authoritative: false };

  private readonly ecfg: SesConfig;
  /** 保留域名与 EMAIL_SANDBOX_POLICY=outbox 时改写进本机 outbox */
  private readonly local: OutboxEmail;
  private sdkPromise?: Promise<SesSdk>;
  private nextSendAt = 0;
  private readonly stats = {
    sent: 0, rejected: [] as number[], errors: [] as number[], suppressed: 0, reserved: 0, rewritten: 0, lastError: undefined as string | undefined,
  };
  readonly feedbackStats: PollStats = newPollStats();
  private lastProbeMail?: { messageId: string; at: number };

  constructor(protected readonly deps: AdapterDeps) {
    const e = deps.cfg.email;
    if (e.EMAIL_DRIVER !== 'ses') throw new Error(`SesEmail 需要 EMAIL_DRIVER=ses（当前 ${e.EMAIL_DRIVER}）`);
    this.ecfg = e;
    this.local = new OutboxEmail(deps);
  }

  private client(): Promise<SESv2Client> {
    return this.deps.aws.sesv2();
  }

  private sdk(): Promise<SesSdk> {
    this.sdkPromise ??= loadAwsPackage('@aws-sdk/client-sesv2', () => import('@aws-sdk/client-sesv2'));
    return this.sdkPromise;
  }

  private bump(list: number[]): void {
    const now = Date.now();
    const kept = list.filter((t) => now - t < WINDOW_MS);
    list.length = 0;
    list.push(...kept.slice(-99), now);
  }

  private recent(list: number[]): number {
    const now = Date.now();
    return list.filter((t) => now - t < WINDOW_MS).length;
  }

  /** 进程内限速：两次 SendEmail 之间至少间隔 1 / EMAIL_SEND_RATE_PER_SEC 秒 */
  private async throttle(): Promise<void> {
    const gap = 1000 / Math.max(0.01, this.ecfg.EMAIL_SEND_RATE_PER_SEC);
    const now = Date.now();
    const at = Math.max(now, this.nextSendAt);
    this.nextSendAt = at + gap;
    if (at > now) await sleep(at - now);
  }

  /** 交给本机 outbox（不调用 SES），并在记录上写明原因 */
  private async writeLocal(msg: EmailMessage, note: string, path: string): Promise<{ messageId: string; transport: 'outbox' | 'ses'; delivered: boolean }> {
    const r = await this.local.send(msg);
    await need(this.deps, 'db', 'SesEmail')('outbox_emails').where({ message_id: r.messageId }).update({ error: note });
    markPath('email', path);
    return { messageId: r.messageId, transport: 'outbox', delivered: false };
  }

  async send(msg: EmailMessage): Promise<{ messageId: string; transport: 'outbox' | 'ses'; delivered: boolean }> {
    const db = need(this.deps, 'db', 'SesEmail');
    if (!msg.to.length) throw new Error('EmailMessage.to 不能为空');
    const to = [...new Set(msg.to.map((a) => a.trim().toLowerCase()))];
    // 1. 保留域名（PM-46）
    let real = to.filter((a) => !isReservedAddress(a));
    if (!real.length) {
      this.stats.reserved += 1;
      return this.writeLocal({ ...msg, to }, `${RESERVED_NOTE}（保留域名不调用 SES）`, 'outbox:reserved');
    }
    const messageId = ulid();
    const now = new Date();
    // 2. 抑制（只发必要邮件）
    if (!ESSENTIAL_CATEGORIES.has(msg.category)) {
      const rows = (await db('users').whereRaw(`lower(email) in (${real.map(() => '?').join(', ')})`, real)
        .whereIn('email_status', ['bounced', 'complained']).select('email', 'email_status')) as Array<{ email: string; email_status: string }>;
      if (rows.length) {
        const blocked = new Set(rows.map((r) => r.email.toLowerCase()));
        real = real.filter((a) => !blocked.has(a));
        if (!real.length) {
          this.stats.suppressed += 1;
          await insertOutboxEmail(db, {
            messageId, to, subject: msg.subject, category: msg.category, transport: 'ses', status: 'failed',
            userId: to.length === 1 ? (await findUserByEmail(db, to[0]!))?.id ?? null : null,
            error: `ses:suppressed：收件人状态为 ${rows.map((r) => `${r.email}=${r.email_status}`).join(', ')}，只发验证与重置密码邮件`,
          });
          markPath('email', 'ses:suppressed');
          return { messageId, transport: 'ses', delivered: false };
        }
      }
    }
    // 3. 限速 + SendEmail(Raw)
    await this.throttle();
    const from = this.deps.cfg.email.EMAIL_FROM;
    const raw = buildMime({ ...msg, to: real, from, messageId, date: now, transport: 'ses' });
    const userId = real.length === 1 ? (await findUserByEmail(db, real[0]!))?.id ?? null : null;
    const { SendEmailCommand } = await this.sdk();
    try {
      const ses = await this.client();
      const r = await ses.send(new SendEmailCommand({
        FromEmailAddress: from,
        Destination: { ToAddresses: real },
        Content: { Raw: { Data: Buffer.from(raw, 'utf8') } },
        ...(this.ecfg.SES_CONFIGURATION_SET ? { ConfigurationSetName: this.ecfg.SES_CONFIGURATION_SET } : {}),
        EmailTags: emailTagsOf(msg),
      }));
      this.stats.sent += 1;
      await insertOutboxEmail(db, {
        messageId, to: real, subject: msg.subject, category: msg.category, transport: 'ses', status: 'sent', userId,
        providerMessageId: r.MessageId ?? null, sentAt: now.toISOString(),
      });
      markPath('email', 'ses:sent');
      return { messageId, transport: 'ses', delivered: true };
    } catch (e) {
      const rejected = awsErrorName(e) === 'MessageRejected';
      this.stats.lastError = describeAwsError(e);
      this.bump(rejected ? this.stats.rejected : this.stats.errors);
      if (rejected && this.ecfg.EMAIL_SANDBOX_POLICY === 'outbox') {
        this.stats.rewritten += 1;
        return this.writeLocal({ ...msg, to: real },
          `${describeAwsError(e)}（EMAIL_SANDBOX_POLICY=outbox：已改写进本机 outbox，未真正发出）`, 'ses:rejected');
      }
      await insertOutboxEmail(db, {
        messageId, to: real, subject: msg.subject, category: msg.category, transport: 'ses', status: 'failed', userId, error: describeAwsError(e),
      });
      markPath('email', rejected ? 'ses:rejected' : 'ses:error');
      this.deps.logger?.warn('email.ses.send_failed', { messageId, category: msg.category, error: describeAwsError(e) });
      return { messageId, transport: 'ses', delivered: false };
    }
  }

  async listRecent(limit: number): Promise<Array<{ messageId: string; to: string[]; subject: string; category: string; at: string; status: string }>> {
    const { items } = await listOutbox(need(this.deps, 'db', 'SesEmail'), { limit });
    return items.map((r) => ({ messageId: r.message_id, to: r.to_addrs, subject: r.subject, category: r.category, at: r.created_at, status: r.status }));
  }

  /** 只有改写进本机 outbox 的邮件（保留域名、沙盒策略 outbox）有正文 */
  readBody(row: Pick<OutboxEmailRow, 'eml_path'>): (ParsedEml & { raw: string }) | null {
    return this.local.readBody(row);
  }

  resolveEmlPath(emlPath: string): string {
    return this.local.resolveEmlPath(emlPath);
  }

  // ------------------------------------------------------------------------------------------
  // worker：反馈队列
  // ------------------------------------------------------------------------------------------
  /** 处理反馈队列的一条消息（测试与 consume() 共用）；不是 SES 事件时返回 false（留给 DLQ） */
  async handleFeedback(body: string | undefined): Promise<boolean> {
    const f = parseSesFeedback(body);
    if (!f) {
      this.deps.logger?.warn('email.feedback.invalid', { sample: (body ?? '').slice(0, 120) });
      return false;
    }
    await applySesFeedback(need(this.deps, 'db', 'SesEmail'), f);
    return true;
  }

  /** worker 调用（阻塞直到 signal 终止）：长轮询 SES_FEEDBACK_QUEUE_URL；没有反馈队列时立即返回 */
  async consume(opts: { signal: AbortSignal }): Promise<void> {
    if (!this.ecfg.SES_FEEDBACK_QUEUE_URL) return;
    await pollQueue({
      name: 'email.feedback', queueUrl: this.ecfg.SES_FEEDBACK_QUEUE_URL, client: () => this.deps.aws.sqs(), signal: opts.signal,
      stats: this.feedbackStats, ...(this.deps.logger ? { logger: this.deps.logger } : {}),
      handle: (m) => this.handleFeedback(m.Body),
    });
  }

  // ------------------------------------------------------------------------------------------
  // 探针
  // ------------------------------------------------------------------------------------------
  private async queueAttributes(url: string, names: QueueAttributeName[]): Promise<Record<string, string>> {
    const { GetQueueAttributesCommand } = await loadAwsPackage('@aws-sdk/client-sqs', () => import('@aws-sdk/client-sqs'));
    const r = await (await this.deps.aws.sqs()).send(new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: names }));
    return r.Attributes ?? {};
  }

  private async feedbackDepths(): Promise<{ depth: number; dlqDepth?: number; dlqUrl?: string } | undefined> {
    const url = this.ecfg.SES_FEEDBACK_QUEUE_URL;
    if (!url) return undefined;
    const main = await withAwsRetry(() => this.queueAttributes(url, ['ApproximateNumberOfMessages', 'RedrivePolicy']));
    let dlqArn: string | undefined;
    try {
      dlqArn = (JSON.parse(main.RedrivePolicy ?? '{}') as { deadLetterTargetArn?: string }).deadLetterTargetArn;
    } catch {
      dlqArn = undefined;
    }
    const dlqUrl = dlqArn ? queueUrlFromArn(dlqArn, this.deps.cfg.core.AWS_ENDPOINT_URL || undefined) : undefined;
    let dlqDepth: number | undefined;
    if (dlqUrl) {
      try {
        dlqDepth = Number((await withAwsRetry(() => this.queueAttributes(dlqUrl, ['ApproximateNumberOfMessages']))).ApproximateNumberOfMessages ?? 0);
      } catch {
        dlqDepth = undefined;
      }
    }
    return { depth: Number(main.ApproximateNumberOfMessages ?? 0), ...(dlqDepth !== undefined ? { dlqDepth } : {}), ...(dlqUrl ? { dlqUrl } : {}) };
  }

  /** 深度探针：向 SES 邮箱模拟器发探针邮件（10 分钟最多一次），报告上一封是否已回流为“已投递” */
  private async probeMail(): Promise<{ sent?: string; previousDelivered?: boolean }> {
    const db = this.deps.db;
    const prev = this.lastProbeMail;
    let previousDelivered: boolean | undefined;
    if (prev && db) {
      const row = (await db('outbox_emails').where({ message_id: prev.messageId }).first('delivery_status')) as { delivery_status?: string } | undefined;
      previousDelivered = row?.delivery_status === 'delivered';
    }
    if (prev && Date.now() - prev.at < PROBE_MAIL_MIN_INTERVAL_MS) return { ...(previousDelivered !== undefined ? { previousDelivered } : {}) };
    const r = await this.send({
      to: [SIMULATOR_SUCCESS], subject: 'CloudAlbum SES probe', text: 'CloudAlbum email module health probe (SES mailbox simulator).',
      category: 'system', tags: { flow: 'probe' },
    });
    if (r.transport === 'ses' && r.delivered) this.lastProbeMail = { messageId: r.messageId, at: Date.now() };
    return { sent: r.messageId, ...(previousDelivered !== undefined ? { previousDelivered } : {}) };
  }

  async probe(opts?: { deep?: boolean }): Promise<ProbeResult> {
    const t0 = performance.now();
    const { GetAccountCommand, GetEmailIdentityCommand } = await this.sdk();
    let account: GetAccountCommandOutput;
    let identity: GetEmailIdentityCommandOutput;
    let feedback: Awaited<ReturnType<SesEmail['feedbackDepths']>>;
    try {
      [account, identity, feedback] = await Promise.all([
        withAwsRetry(async () => (await this.client()).send(new GetAccountCommand({}))),
        withAwsRetry(async () => (await this.client()).send(new GetEmailIdentityCommand({ EmailIdentity: this.ecfg.SES_IDENTITY }))),
        this.feedbackDepths(),
      ]);
    } catch (e) {
      if (e instanceof AwsCredentialsUnavailableError) return { status: 'error', detail: e.message, confidence: 'confirmed' };
      if (isAwsTransient(e)) {
        return { status: 'degraded', transient: true, confidence: 'observed', detail: `SES 控制面暂时不可达（将重试）：${describeAwsError(e)}` };
      }
      const why = isAwsNotFound(e) ? `发件身份 ${this.ecfg.SES_IDENTITY} 或反馈队列不存在（本区域）` : isAwsAccessDenied(e) ? '无权限（检查本栈 PolicyArn 是否已附加）' : describeAwsError(e);
      return { status: 'error', detail: `邮件发送不可用：${why}`, confidence: 'confirmed' };
    }
    const latencyMs = Math.round((performance.now() - t0) * 10) / 10;
    const q = account.SendQuota ?? {};
    const sent24h = Math.round(q.SentLast24Hours ?? 0);
    const max24h = Math.round(q.Max24HourSend ?? 0);
    const production = account.ProductionAccessEnabled === true;
    const dkim = identity.DkimAttributes?.Status ?? 'NOT_STARTED';
    const verified = identity.VerifiedForSendingStatus === true;

    const extra: Record<string, unknown> = {};
    if (opts?.deep && verified && account.SendingEnabled !== false) {
      try {
        extra.probeMail = await this.probeMail();
      } catch (e) {
        extra.probeMailError = describeAwsError(e);
      }
    }
    const data = {
      identity: this.ecfg.SES_IDENTITY, identityType: identity.IdentityType, verified, verificationStatus: identity.VerificationStatus, dkim,
      configurationSet: this.ecfg.SES_CONFIGURATION_SET ?? null,
      account: { production, sendingEnabled: account.SendingEnabled !== false, enforcement: account.EnforcementStatus, sentLast24Hours: sent24h, max24HourSend: max24h, maxSendRate: q.MaxSendRate },
      feedback: feedback ?? null,
      stats: {
        sent: this.stats.sent, rejectedLast5m: this.recent(this.stats.rejected), errorsLast5m: this.recent(this.stats.errors),
        suppressed: this.stats.suppressed, reserved: this.stats.reserved, rewrittenToOutbox: this.stats.rewritten,
        ...(this.stats.lastError ? { lastError: this.stats.lastError } : {}),
      },
      consumer: { ...this.feedbackStats },
      sandboxPolicy: this.ecfg.EMAIL_SANDBOX_POLICY,
      ...extra,
    };
    if (account.SendingEnabled === false) {
      return { status: 'error', detail: `邮件发送不可用：账号的发送功能已暂停（SendingEnabled=false，EnforcementStatus=${account.EnforcementStatus ?? '?'}）`, latencyMs, confidence: 'confirmed', data };
    }
    if (!verified) {
      return { status: 'error', detail: `邮件发送不可用：发件身份 ${this.ecfg.SES_IDENTITY} 尚未验证（${identity.VerificationStatus ?? 'PENDING'}；邮箱身份请点击验证邮件，域名身份请添加 DKIM CNAME）`, latencyMs, confidence: 'confirmed', data };
    }
    const problems: string[] = [];
    if (!production) problems.push(`沙盒：只能发给已验证地址 · 今日已发 ${sent24h} / 上限 ${max24h}`);
    const rejected = this.recent(this.stats.rejected);
    if (rejected) problems.push(`最近 5 分钟有 ${rejected} 封被拒（MessageRejected）`);
    if (this.recent(this.stats.errors)) problems.push(`最近 5 分钟 SendEmail 失败 ${this.recent(this.stats.errors)} 次`);
    if (feedback?.dlqDepth) problems.push(`反馈 DLQ 有 ${feedback.dlqDepth} 条`);
    if (account.EnforcementStatus && !['HEALTHY'].includes(account.EnforcementStatus)) problems.push(`账号信誉状态 ${account.EnforcementStatus}`);
    const parts = [
      ...(production ? [`生产访问 · 今日已发 ${sent24h} / 上限 ${max24h}`] : []),
      `身份 ${this.ecfg.SES_IDENTITY}（${identity.IdentityType === 'DOMAIN' ? `域名，DKIM ${dkim}` : '邮箱'}）`,
      ...(feedback ? [`反馈队列 ${feedback.depth}`] : ['未配置反馈队列']),
    ];
    return {
      status: problems.length ? 'degraded' : 'ok',
      detail: [...problems, ...parts].join(' · '),
      latencyMs,
      confidence: 'confirmed',
      data,
    };
  }
}
