// backend/src/adapters/notification/sns.ts —— NotifierPort 的 `sns` 驱动（Amazon SNS，04#notification 第 2 节；wave1-sns-ses）
//
// 发布：一次 Publish（MessageStructure=json）：default 为纯文本摘要，email 为稍长的纯文本（SNS 邮件订阅只能发纯文本），
//   sqs 为完整事件 JSON（收件队列开了原始消息传递，worker 直接解析）。消息属性 eventType、userId（audience=admin 时为 '*'）、
//   audience、origin、eventId——订阅过滤策略按消息属性匹配，发布时漏带属性，所有带过滤策略的订阅都收不到。
//   Subject 只用可打印 ASCII（SNS 对 Subject 的字符集限制以官方文档为准；中文标题放在邮件正文第一行）。
//   每次发布写一行 notification_deliveries（channel=sns）；同一 eventId 已发布过则跳过（至少一次投递的幂等）。
// 订阅：subscribeEmail() 调 Subscribe(Protocol=email, ReturnSubscriptionArn=true, FilterPolicy={"userId":[id]})；管理员用
//   {"$or":[{"userId":[id]},{"audience":["admin"]}]}，管理员广播也能送到每一位管理员。ARN 与 pending 状态写入 notification_prefs。
//   保留域名（example.com 等，06 PM-46 / PM-M23）不建订阅。同一地址已用不同属性订阅过时改为更新过滤策略。
// worker（consume()）：长轮询收件队列（inbox.ts：记 sqs-copy 投递、代写 origin≠ec2 的站内信），并每 NOTIFY_STATUS_SYNC_SEC 秒同步
//   一次订阅状态（syncSubscriptions：pending → confirmed；订阅消失 = 用户点了退订链接或确认过期 → email_enabled=false + 站内信；
//   角色变化后改写过滤策略）。多实例时同步任务经 LockPort 只在一台上执行。
// 探针：GetTopicAttributes + ListSubscriptionsByTopic + 收件队列 / 订阅级 DLQ 的 GetQueueAttributes，统一经 withAwsRetry；
//   瞬时失败报 degraded（transient），连续失败由能力注册表升级为 error；控制面读取在后台进行（adapters/aws/background-probe.ts），
//   探针最多等 1.5 秒（深度 4 秒）。深度探针另外比对 notification_prefs、读 CloudWatch 的
//   NumberOfNotificationsFilteredOut / Failed，并发布一条 probe=true 的探针消息（只进收件队列，过滤策略挡住所有邮件订阅）。
// 非权威端口：Publish 失败抛 503（fanout() 只记日志，站内信不受影响），路径段 notification=sns:error；不回退到 db 驱动逐个发信。
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { PublishCommandInput, SNSClient, Subscription } from '@aws-sdk/client-sns';
import type { QueueAttributeName } from '@aws-sdk/client-sqs';
import { ulid } from 'ulid';
import { HttpError } from '../../errors.js';
import { markPath } from '../../observability/request-context.js';
import type { AdapterMeta, ProbeResult } from '../../ports/common.js';
import type { NotificationEvent, NotifierPort } from '../../ports/notifier.js';
import { deliveryExists, getNotificationPrefs, insertDelivery, insertNotification, setNotificationPrefs } from '../../repositories/notifications.js';
import { findUserById } from '../../repositories/users.js';
import {
  AwsCredentialsUnavailableError, awsErrorName, describeAwsError, isAwsAccessDenied, isAwsNotFound, isAwsTransient, loadAwsPackage, withAwsRetry,
} from '../aws/clients.js';
import { BackgroundProbe } from '../aws/background-probe.js';
import { isReservedAddress } from '../email/reserved.js';
import type { AdapterDeps } from '../types.js';
import { need } from '../types.js';
import { handleInboxMessage, parseInboxMessage } from './inbox.js';
import { newPollStats, pollQueue, sleep, type PollStats } from './sqs-poll.js';

type SnsConfig = Extract<AdapterDeps['cfg']['notification'], { NOTIFY_DRIVER: 'sns' }>;
type SnsSdk = typeof import('@aws-sdk/client-sns');
type SqsSdk = typeof import('@aws-sdk/client-sqs');

/** Subject 用的英文事件名（标题含非 ASCII 字符时使用） */
const ASCII_SUBJECT: Record<NotificationEvent['type'], string> = {
  'comment.created': 'New comment on your photo',
  'like.created': 'New like on your photo',
  'photo.blocked': 'A photo was blocked by moderation',
  'report.ready': 'Daily report is ready',
};

export type FilterPolicy = { userId: string[] } | { $or: [{ userId: string[] }, { audience: ['admin'] }] };

/** 用户邮件订阅的过滤策略（作用范围 MessageAttributes） */
export function filterPolicyFor(userId: string, isAdmin: boolean): FilterPolicy {
  return isAdmin ? { $or: [{ userId: [userId] }, { audience: ['admin'] }] } : { userId: [userId] };
}

/** 两份过滤策略是否等价（键序无关） */
export function samePolicy(a: unknown, b: unknown): boolean {
  const norm = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, norm((v as Record<string, unknown>)[k])]));
    return v;
  };
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}

export function snsSubject(evt: Pick<NotificationEvent, 'title' | 'type'>): string {
  const t = evt.title.replace(/[\r\n\t]+/g, ' ').trim();
  const ascii = /^[\x20-\x7e]+$/.test(t) && /^[A-Za-z0-9\p{P}]/u.test(t);
  return `CloudAlbum: ${(ascii ? t : ASCII_SUBJECT[evt.type] ?? 'notification')}`.slice(0, 99);
}

export function absoluteLink(link: string | undefined, baseUrl: string): string | undefined {
  if (!link) return undefined;
  if (/^https?:\/\//.test(link)) return link;
  return `${baseUrl.replace(/\/+$/, '')}${link.startsWith('/') ? '' : '/'}${link}`;
}

/** email 协议的纯文本（SNS 会在末尾追加退订链接） */
export function renderPlainText(evt: NotificationEvent, baseUrl: string): string {
  const link = absoluteLink(evt.link, baseUrl);
  return [
    evt.title, '', evt.body, ...(link ? ['', link] : []), '',
    '—— CloudAlbum（本邮件经 Amazon SNS 发送；不想再收到时，点击下方的退订链接，或在设置页关闭邮件通知）',
  ].join('\n');
}

/** Publish 的完整输入（单元测试直接断言它） */
export function buildPublishInput(evt: NotificationEvent, topicArn: string, baseUrl: string): PublishCommandInput {
  const link = absoluteLink(evt.link, baseUrl);
  const summary = `${evt.title}：${evt.body}${link ? ` ${link}` : ''}`;
  return {
    TopicArn: topicArn,
    Subject: snsSubject(evt),
    MessageStructure: 'json',
    Message: JSON.stringify({ default: summary, email: renderPlainText(evt, baseUrl), sqs: JSON.stringify(evt) }),
    MessageAttributes: {
      eventType: { DataType: 'String', StringValue: evt.type },
      userId: { DataType: 'String', StringValue: evt.audience === 'admin' ? '*' : evt.recipientUserId || '*' },
      audience: { DataType: 'String', StringValue: evt.audience },
      origin: { DataType: 'String', StringValue: evt.origin },
      eventId: { DataType: 'String', StringValue: evt.eventId },
    },
  };
}

export function topicNameOf(arn: string): string {
  return arn.split(':').pop() ?? arn;
}

export interface SyncReport {
  checked: number;
  confirmed: number;
  removed: number;
  filterUpdated: number;
  errors: number;
  at: string;
}

const PROBE_PUBLISH_MIN_INTERVAL_MS = 60_000;
const FAILURE_WINDOW_MS = 5 * 60_000;

export class SnsNotifier implements NotifierPort {
  readonly meta: AdapterMeta = { module: 'notification', driver: 'sns', awsService: 'Amazon SNS', authoritative: false };

  private readonly ncfg: SnsConfig;
  private snsSdk?: Promise<SnsSdk>;
  private sqsSdk?: Promise<SqsSdk>;
  private readonly stats = { published: 0, failed: 0, failures: [] as number[], lastError: undefined as string | undefined };
  readonly inboxStats: PollStats = newPollStats();
  private lastSync?: SyncReport;
  private lastProbePublish?: { eventId: string; at: number };
  private filteredLastHour?: { filtered: number; failed: number; delivered: number; at: string };
  /** 控制面读取放在后台（wave1-fix）：探针最多等 1.5 秒（深度 4 秒），不占用能力注册表 2 秒的探针预算 */
  private readonly bg = new BackgroundProbe({ label: 'SNS / SQS 控制面' });

  constructor(protected readonly deps: AdapterDeps) {
    const n = deps.cfg.notification;
    if (n.NOTIFY_DRIVER !== 'sns') throw new Error(`SnsNotifier 需要 NOTIFY_DRIVER=sns（当前 ${n.NOTIFY_DRIVER}）`);
    this.ncfg = n;
  }

  private sns(): Promise<SNSClient> {
    return this.deps.aws.sns();
  }

  private sdk(): Promise<SnsSdk> {
    this.snsSdk ??= loadAwsPackage('@aws-sdk/client-sns', () => import('@aws-sdk/client-sns'));
    return this.snsSdk;
  }

  private sqs(): Promise<SqsSdk> {
    this.sqsSdk ??= loadAwsPackage('@aws-sdk/client-sqs', () => import('@aws-sdk/client-sqs'));
    return this.sqsSdk;
  }

  get topicArn(): string {
    return this.ncfg.NOTIFY_TOPIC_ARN;
  }

  private get baseUrl(): string {
    return this.deps.cfg.core.APP_BASE_URL;
  }

  private recordFailure(e: unknown): void {
    const now = Date.now();
    this.stats.failed += 1;
    this.stats.lastError = describeAwsError(e);
    this.stats.failures = [...this.stats.failures.filter((t) => now - t < FAILURE_WINDOW_MS), now].slice(-100);
  }

  private recentFailures(): number {
    const now = Date.now();
    return this.stats.failures.filter((t) => now - t < FAILURE_WINDOW_MS).length;
  }

  // ------------------------------------------------------------------------------------------
  // 发布
  // ------------------------------------------------------------------------------------------
  async publish(evt: NotificationEvent): Promise<{ deliveryId: string; channels: Array<'email' | 'sns'> }> {
    const db = need(this.deps, 'db', 'SnsNotifier');
    const target = topicNameOf(this.topicArn);
    if (await deliveryExists(db, evt.eventId, 'sns', target)) {
      markPath('notification', 'sns:duplicate');
      return { deliveryId: evt.eventId, channels: ['sns'] };
    }
    const { PublishCommand } = await this.sdk();
    let messageId = '';
    try {
      const sns = await this.sns();
      const r = await sns.send(new PublishCommand(buildPublishInput(evt, this.topicArn, this.baseUrl)));
      messageId = r.MessageId ?? '';
    } catch (e) {
      this.recordFailure(e);
      markPath('notification', 'sns:error');
      await insertDelivery(db, { eventId: evt.eventId, channel: 'sns', target, status: 'failed', detail: describeAwsError(e) }).catch(() => undefined);
      throw new HttpError(503, 'NOTIFICATION_UNAVAILABLE', `SNS Publish 失败：${describeAwsError(e)}`, { module: 'notification', driver: 'sns' });
    }
    this.stats.published += 1;
    await insertDelivery(db, { eventId: evt.eventId, channel: 'sns', target, status: 'sent', detail: `MessageId=${messageId} audience=${evt.audience}` });
    markPath('notification', 'sns:published');
    return { deliveryId: messageId || evt.eventId, channels: ['sns'] };
  }

  // ------------------------------------------------------------------------------------------
  // 订阅
  // ------------------------------------------------------------------------------------------
  private async subscriptionAttributes(arn: string): Promise<Record<string, string> | null> {
    const { GetSubscriptionAttributesCommand } = await this.sdk();
    try {
      const sns = await this.sns();
      const r = await sns.send(new GetSubscriptionAttributesCommand({ SubscriptionArn: arn }));
      return r.Attributes ?? {};
    } catch (e) {
      if (isAwsNotFound(e)) return null;
      throw e;
    }
  }

  /**
   * 只改 email 订阅的过滤策略（wave1-fix）：sns:SetSubscriptionAttributes 不支持 sns:Protocol 条件键，应用策略无法按协议收窄，
   * 所以在这里先确认协议——收件队列（sqs）等其他订阅的过滤策略只由 CloudFormation 维护。
   */
  private async setFilterPolicy(arn: string, policy: FilterPolicy, protocol: string | undefined): Promise<void> {
    if (protocol !== 'email') throw new Error(`拒绝修改非 email 订阅的过滤策略（${protocol ?? '协议未知'}）：${arn}`);
    const { SetSubscriptionAttributesCommand } = await this.sdk();
    const sns = await this.sns();
    await sns.send(new SetSubscriptionAttributesCommand({ SubscriptionArn: arn, AttributeName: 'FilterPolicy', AttributeValue: JSON.stringify(policy) }));
  }

  /** 主题上的全部订阅（最多 maxPages 页，每页 100 个） */
  async listSubscriptions(maxPages = 5): Promise<Subscription[]> {
    const { ListSubscriptionsByTopicCommand } = await this.sdk();
    const sns = await this.sns();
    const out: Subscription[] = [];
    let token: string | undefined;
    for (let i = 0; i < maxPages; i += 1) {
      const r = await sns.send(new ListSubscriptionsByTopicCommand({ TopicArn: this.topicArn, ...(token ? { NextToken: token } : {}) }));
      out.push(...(r.Subscriptions ?? []));
      token = r.NextToken;
      if (!token) break;
    }
    return out;
  }

  private unavailable(op: string, e: unknown): HttpError {
    return new HttpError(503, 'NOTIFICATION_UNAVAILABLE', `SNS ${op} 失败：${describeAwsError(e)}`, { module: 'notification', driver: 'sns' });
  }

  async subscribeEmail(userId: string, address: string): Promise<{ pendingConfirmation: boolean }> {
    const db = need(this.deps, 'db', 'SnsNotifier');
    const addr = address.trim().toLowerCase();
    if (isReservedAddress(addr)) {
      // 保留域名不建订阅（不会真的有人去点确认邮件，也避免 SNS 退信）；站外通知等于关闭，设置值仍保留
      await setNotificationPrefs(db, userId, { emailEnabled: true, snsSubscriptionArn: null, snsStatus: 'reserved' });
      markPath('notification', 'sns:reserved');
      return { pendingConfirmation: false };
    }
    const user = await findUserById(db, userId);
    const policy = filterPolicyFor(userId, user?.role === 'admin');
    const prefs = await getNotificationPrefs(db, userId);
    const { SubscribeCommand, UnsubscribeCommand } = await this.sdk();
    try {
      // 已有订阅：同一地址则只校正过滤策略；地址变了先删旧订阅
      if (prefs.snsSubscriptionArn?.startsWith('arn:')) {
        const attrs = await this.subscriptionAttributes(prefs.snsSubscriptionArn);
        if (attrs && (attrs.Endpoint ?? '').toLowerCase() === addr) {
          if (!samePolicy(safeJson(attrs.FilterPolicy), policy)) await this.setFilterPolicy(prefs.snsSubscriptionArn, policy, attrs.Protocol);
          const pending = attrs.PendingConfirmation === 'true';
          await setNotificationPrefs(db, userId, { emailEnabled: true, snsStatus: pending ? 'pending' : 'confirmed' });
          markPath('notification', pending ? 'sns:subscribe-pending' : 'sns:subscribed');
          return { pendingConfirmation: pending };
        }
        if (attrs) await (await this.sns()).send(new UnsubscribeCommand({ SubscriptionArn: prefs.snsSubscriptionArn })).catch(() => undefined);
      }
      let arn: string | undefined;
      try {
        const r = await (await this.sns()).send(new SubscribeCommand({
          TopicArn: this.topicArn, Protocol: 'email', Endpoint: addr, ReturnSubscriptionArn: true,
          Attributes: { FilterPolicy: JSON.stringify(policy), FilterPolicyScope: 'MessageAttributes' },
        }));
        arn = r.SubscriptionArn;
      } catch (e) {
        // 同一地址已经用不同属性订阅过（例如角色变了）：找到它，改写过滤策略
        if (!/InvalidParameter/.test(awsErrorName(e)) || !/already exists/i.test((e as Error).message)) throw e;
        const existing = (await this.listSubscriptions()).find((s) => s.Protocol === 'email' && (s.Endpoint ?? '').toLowerCase() === addr);
        if (!existing?.SubscriptionArn?.startsWith('arn:')) throw e;
        await this.setFilterPolicy(existing.SubscriptionArn, policy, existing.Protocol);
        arn = existing.SubscriptionArn;
      }
      let pending = true;
      if (arn?.startsWith('arn:')) {
        const attrs = await this.subscriptionAttributes(arn).catch(() => null);
        if (attrs) pending = attrs.PendingConfirmation !== 'false';
      }
      await setNotificationPrefs(db, userId, {
        emailEnabled: true, snsSubscriptionArn: arn?.startsWith('arn:') ? arn : null, snsStatus: pending ? 'pending' : 'confirmed',
      });
      markPath('notification', pending ? 'sns:subscribe-pending' : 'sns:subscribed');
      return { pendingConfirmation: pending };
    } catch (e) {
      if (e instanceof HttpError) throw e;
      markPath('notification', 'sns:error');
      throw this.unavailable('Subscribe', e);
    }
  }

  /** 删除用户的 SNS 订阅（不改 email_enabled；migrate down 用它，unsubscribe() 再把设置关掉） */
  async dropSubscription(userId: string): Promise<{ removed: boolean }> {
    const db = need(this.deps, 'db', 'SnsNotifier');
    const prefs = await getNotificationPrefs(db, userId);
    let removed = false;
    if (prefs.snsSubscriptionArn?.startsWith('arn:')) {
      const { UnsubscribeCommand } = await this.sdk();
      try {
        await (await this.sns()).send(new UnsubscribeCommand({ SubscriptionArn: prefs.snsSubscriptionArn }));
        removed = true;
      } catch (e) {
        // 订阅已经不存在（用户点过退订链接、待确认过期）或尚未确认：都当作已删除；权限与瞬时错误交给调用方
        if (!isAwsNotFound(e) && !/InvalidParameter/.test(awsErrorName(e))) throw this.unavailable('Unsubscribe', e);
      }
    }
    await setNotificationPrefs(db, userId, { snsSubscriptionArn: null, snsStatus: null });
    return { removed };
  }

  async unsubscribe(userId: string): Promise<void> {
    await this.dropSubscription(userId);
    await setNotificationPrefs(need(this.deps, 'db', 'SnsNotifier'), userId, { emailEnabled: false });
    markPath('notification', 'sns:unsubscribed');
  }

  /**
   * 订阅状态同步（worker 每 NOTIFY_STATUS_SYNC_SEC 秒一次）：pending → confirmed；订阅消失 → email_enabled=false + 站内信；
   * 角色变化 → 改写过滤策略。遇到瞬时错误本轮提前结束，下一轮继续。
   */
  async syncSubscriptions(opts: { limit?: number } = {}): Promise<SyncReport> {
    const db = need(this.deps, 'db', 'SnsNotifier');
    const report: SyncReport = { checked: 0, confirmed: 0, removed: 0, filterUpdated: 0, errors: 0, at: new Date().toISOString() };
    const rows = (await db('notification_prefs').whereNotNull('sns_subscription_arn').limit(opts.limit ?? 500)) as Array<{
      user_id: string; sns_subscription_arn: string; sns_status: string | null; email_enabled: unknown;
    }>;
    for (const row of rows) {
      if (!row.sns_subscription_arn.startsWith('arn:')) continue;
      report.checked += 1;
      let attrs: Record<string, string> | null;
      try {
        attrs = await withAwsRetry(() => this.subscriptionAttributes(row.sns_subscription_arn));
      } catch (e) {
        report.errors += 1;
        if (isAwsTransient(e)) break;
        continue;
      }
      if (!attrs) {
        const wasConfirmed = row.sns_status === 'confirmed';
        await setNotificationPrefs(db, row.user_id, { emailEnabled: false, snsSubscriptionArn: null, snsStatus: wasConfirmed ? 'unsubscribed' : 'expired' });
        await insertNotification(db, {
          eventId: `sns-gone:${createHash('sha256').update(row.sns_subscription_arn).digest('hex').slice(0, 40)}`,
          userId: row.user_id, type: 'notification.unsubscribed',
          title: '邮件通知已关闭',
          body: wasConfirmed
            ? '你已通过邮件中的退订链接取消了邮件通知。需要时可以在设置页重新开启。'
            : '邮件通知的确认邮件没有被确认（链接已过期），邮件通知已关闭。需要时可以在设置页重新开启。',
          link: '/settings',
        });
        report.removed += 1;
        continue;
      }
      const pending = attrs.PendingConfirmation === 'true';
      if (!pending && row.sns_status !== 'confirmed') {
        await setNotificationPrefs(db, row.user_id, { snsStatus: 'confirmed' });
        report.confirmed += 1;
      }
      const user = await findUserById(db, row.user_id);
      const want = filterPolicyFor(row.user_id, user?.role === 'admin');
      if (!samePolicy(safeJson(attrs.FilterPolicy), want)) {
        try {
          await this.setFilterPolicy(row.sns_subscription_arn, want, attrs.Protocol);
          report.filterUpdated += 1;
        } catch {
          report.errors += 1;
        }
      }
    }
    this.lastSync = report;
    return report;
  }

  // ------------------------------------------------------------------------------------------
  // worker：收件队列 + 订阅状态同步
  // ------------------------------------------------------------------------------------------
  /** 处理收件队列的一条消息（测试与 consume() 共用） */
  async handleInbox(body: string | undefined, attributes?: Record<string, { StringValue?: string } | undefined>): Promise<boolean> {
    const msg = parseInboxMessage(body, attributes);
    if (msg.kind === 'invalid') {
      this.deps.logger?.warn('notification.inbox.invalid', { reason: msg.reason });
      return false;                                   // 不删除：接收次数超过 maxReceiveCount 后进入 DLQ
    }
    await handleInboxMessage(need(this.deps, 'db', 'SnsNotifier'), msg);
    return true;
  }

  /** worker 调用（阻塞直到 signal 终止）：收件队列长轮询 + 周期性的订阅状态同步 */
  async consume(opts: { signal: AbortSignal }): Promise<void> {
    await Promise.all([
      pollQueue({
        name: 'notification.inbox', queueUrl: this.ncfg.NOTIFY_INBOX_QUEUE_URL, client: () => this.deps.aws.sqs(), signal: opts.signal,
        stats: this.inboxStats, ...(this.deps.logger ? { logger: this.deps.logger } : {}),
        handle: (m) => this.handleInbox(m.Body, m.MessageAttributes as Record<string, { StringValue?: string }> | undefined),
      }),
      this.syncLoop(opts.signal),
    ]);
  }

  private async syncLoop(signal: AbortSignal): Promise<void> {
    const everyMs = Math.max(30, this.ncfg.NOTIFY_STATUS_SYNC_SEC) * 1000;
    await sleep(Math.min(everyMs, 15_000), signal);
    while (!signal.aborted) {
      const lease = this.deps.lock ? await this.deps.lock.tryAcquire('notification.sns-sync', Math.ceil(everyMs / 1000)).catch(() => null) : undefined;
      if (lease !== null) {
        try {
          await this.syncSubscriptions();
        } catch (e) {
          this.deps.logger?.warn('notification.sync_failed', { error: describeAwsError(e) });
        } finally {
          await lease?.release().catch(() => undefined);
        }
      }
      await sleep(everyMs, signal);
    }
  }

  // ------------------------------------------------------------------------------------------
  // 探针
  // ------------------------------------------------------------------------------------------
  private async queueAttributes(url: string, names: QueueAttributeName[]): Promise<Record<string, string>> {
    const { GetQueueAttributesCommand } = await this.sqs();
    const sqs = await this.deps.aws.sqs();
    const r = await sqs.send(new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: names }));
    return r.Attributes ?? {};
  }

  private async topicAttributes(): Promise<Record<string, string>> {
    const { GetTopicAttributesCommand } = await this.sdk();
    const r = await (await this.sns()).send(new GetTopicAttributesCommand({ TopicArn: this.topicArn }));
    return r.Attributes ?? {};
  }

  /** CloudWatch：最近 1 小时 NumberOfNotificationsFilteredOut / Failed / Delivered 之和（分钟级延迟） */
  private async topicMetrics(): Promise<{ filtered: number; failed: number; delivered: number; at: string }> {
    const { GetMetricDataCommand } = await loadAwsPackage('@aws-sdk/client-cloudwatch', () => import('@aws-sdk/client-cloudwatch'));
    const cw = await this.deps.aws.cloudwatch();
    const end = new Date();
    const start = new Date(end.getTime() - 3_600_000);
    const q = (id: string, name: string) => ({
      Id: id, MetricStat: { Metric: { Namespace: 'AWS/SNS', MetricName: name, Dimensions: [{ Name: 'TopicName', Value: topicNameOf(this.topicArn) }] }, Period: 300, Stat: 'Sum' },
    });
    const r = await cw.send(new GetMetricDataCommand({
      StartTime: start, EndTime: end,
      MetricDataQueries: [q('filtered', 'NumberOfNotificationsFilteredOut'), q('failed', 'NumberOfNotificationsFailed'), q('delivered', 'NumberOfNotificationsDelivered')],
    }));
    const sum = (id: string) => (r.MetricDataResults ?? []).find((x) => x.Id === id)?.Values?.reduce((a, b) => a + b, 0) ?? 0;
    return { filtered: sum('filtered'), failed: sum('failed'), delivered: sum('delivered'), at: end.toISOString() };
  }

  /** 深度探针：发布一条探针消息（只进收件队列），并看上一条有没有被 worker 记下 */
  private async probeMessage(): Promise<{ published?: string; previousSeen?: boolean }> {
    const db = this.deps.db;
    const prev = this.lastProbePublish;
    let previousSeen: boolean | undefined;
    if (prev && db) previousSeen = Boolean(await db('notification_deliveries').where({ event_id: prev.eventId, channel: 'sqs-copy' }).first('id'));
    if (prev && Date.now() - prev.at < PROBE_PUBLISH_MIN_INTERVAL_MS) return { ...(previousSeen !== undefined ? { previousSeen } : {}) };
    const eventId = `probe:${ulid()}`;
    const { PublishCommand } = await this.sdk();
    await (await this.sns()).send(new PublishCommand({
      TopicArn: this.topicArn, Message: JSON.stringify({ probe: true, eventId, at: new Date().toISOString() }),
      MessageAttributes: {
        probe: { DataType: 'String', StringValue: 'true' },
        eventType: { DataType: 'String', StringValue: 'probe' },
        eventId: { DataType: 'String', StringValue: eventId },
        origin: { DataType: 'String', StringValue: 'ec2' },
      },
    }));
    this.lastProbePublish = { eventId, at: Date.now() };
    return { published: eventId, ...(previousSeen !== undefined ? { previousSeen } : {}) };
  }

  async probe(opts?: { deep?: boolean }): Promise<ProbeResult> {
    return this.bg.run(() => this.probeNow(opts), opts?.deep ? { deep: true } : {});
  }

  private async probeNow(opts?: { deep?: boolean }): Promise<ProbeResult> {
    const t0 = performance.now();
    let topic: Record<string, string>;
    let subs: Subscription[];
    let inbox: Record<string, string>;
    let dlq: Record<string, string> | undefined;
    try {
      [topic, subs, inbox, dlq] = await Promise.all([
        withAwsRetry(() => this.topicAttributes()),
        withAwsRetry(() => this.listSubscriptions(3)),
        withAwsRetry(() => this.queueAttributes(this.ncfg.NOTIFY_INBOX_QUEUE_URL, ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible', 'QueueArn'])),
        this.ncfg.NOTIFY_DLQ_URL ? withAwsRetry(() => this.queueAttributes(this.ncfg.NOTIFY_DLQ_URL, ['ApproximateNumberOfMessages'])) : Promise.resolve(undefined),
      ]);
    } catch (e) {
      if (e instanceof AwsCredentialsUnavailableError) return { status: 'error', detail: e.message, confidence: 'confirmed' };
      if (isAwsTransient(e)) {
        return { status: 'degraded', transient: true, confidence: 'observed', detail: `SNS / SQS 控制面暂时不可达（将重试）：${describeAwsError(e)}` };
      }
      const why = isAwsNotFound(e) ? '主题或收件队列不存在' : isAwsAccessDenied(e) ? '无权限（检查本栈 PolicyArn 是否已附加）' : describeAwsError(e);
      return { status: 'error', detail: `notification 主题不可用：${why}`, confidence: 'confirmed' };
    }
    const latencyMs = Math.round((performance.now() - t0) * 10) / 10;

    // 订阅分类：收件队列（sqs）、用户邮件订阅（notification_prefs 中有记录的地址）、运维 / 管理员兜底订阅（参数 AdminEmail）
    const userEmails = new Set<string>();
    let prefsRows: Array<{ user_id: string; sns_status: string | null; email: string }> = [];
    if (this.deps.db) {
      try {
        prefsRows = (await this.deps.db('notification_prefs as p').join('users as u', 'u.id', 'p.user_id')
          .whereNotNull('p.sns_subscription_arn').select('p.user_id', 'p.sns_status', 'u.email')) as typeof prefsRows;
        for (const r of prefsRows) userEmails.add(r.email.toLowerCase());
      } catch {
        prefsRows = [];
      }
    }
    const email = subs.filter((s) => s.Protocol === 'email' || s.Protocol === 'email-json');
    const pendingEmail = email.filter((s) => s.SubscriptionArn === 'PendingConfirmation');
    const opsPending = pendingEmail.filter((s) => !userEmails.has((s.Endpoint ?? '').toLowerCase()));
    const inboxArn = inbox.QueueArn;
    const inboxSub = subs.find((s) => s.Protocol === 'sqs' && (!inboxArn || s.Endpoint === inboxArn));
    const confirmed = Number(topic.SubscriptionsConfirmed ?? subs.filter((s) => s.SubscriptionArn?.startsWith('arn:')).length);
    const pending = Number(topic.SubscriptionsPending ?? pendingEmail.length);
    const inboxVisible = Number(inbox.ApproximateNumberOfMessages ?? 0);
    const dlqDepth = Number(dlq?.ApproximateNumberOfMessages ?? 0);
    const failures = this.recentFailures();

    const extra: Record<string, unknown> = {};
    if (opts?.deep) {
      try {
        this.filteredLastHour = await this.topicMetrics();
      } catch (e) {
        extra.metricsError = describeAwsError(e);
      }
      try {
        Object.assign(extra, { probeMessage: await this.probeMessage() });
      } catch (e) {
        extra.probeMessageError = describeAwsError(e);
      }
      const listed = new Set(email.map((s) => (s.Endpoint ?? '').toLowerCase()));
      extra.prefsWithoutSubscription = prefsRows.filter((r) => !listed.has(r.email.toLowerCase())).length;
    }

    const problems: string[] = [];
    if (opsPending.length) problems.push(`运维订阅待确认（${opsPending.length} 个，请查收 AWS Notifications 的确认邮件）`);
    if (!inboxSub) problems.push('收件队列没有订阅到主题');
    else if (inboxSub.SubscriptionArn === 'PendingConfirmation') problems.push('收件队列订阅待确认');
    if (dlqDepth > 0) problems.push(`订阅级 DLQ 有 ${dlqDepth} 条投递失败的消息`);
    if (failures > 0) problems.push(`最近 5 分钟 Publish 失败 ${failures} 次`);
    const parts = [
      `主题 ${topicNameOf(this.topicArn)}`, `已确认订阅 ${confirmed}`, `待确认 ${pending}`, `收件队列 ${inboxVisible}`,
      ...(this.ncfg.NOTIFY_DLQ_URL ? [`订阅级 DLQ ${dlqDepth}`] : []),
      ...(this.filteredLastHour ? [`最近 1 小时被过滤 ${this.filteredLastHour.filtered}`] : []),
    ];
    return {
      status: problems.length ? 'degraded' : 'ok',
      detail: problems.length ? `${problems.join('；')} · ${parts.join(' · ')}` : parts.join(' · '),
      latencyMs,
      confidence: 'confirmed',
      data: {
        topicArn: this.topicArn, inboxQueueUrl: this.ncfg.NOTIFY_INBOX_QUEUE_URL, dlqUrl: this.ncfg.NOTIFY_DLQ_URL || null,
        subscriptions: {
          confirmed, pending, deleted: Number(topic.SubscriptionsDeleted ?? 0), email: email.length, emailPending: pendingEmail.length,
          opsPending: opsPending.length, users: prefsRows.length, inboxSubscribed: Boolean(inboxSub),
        },
        encrypted: Boolean(topic.KmsMasterKeyId),
        inbox: { visible: inboxVisible, inFlight: Number(inbox.ApproximateNumberOfMessagesNotVisible ?? 0) },
        dlqDepth,
        published: { total: this.stats.published, failed: this.stats.failed, failedLast5m: failures, ...(this.stats.lastError ? { lastError: this.stats.lastError } : {}) },
        consumer: { ...this.inboxStats },
        ...(this.lastSync ? { lastSync: this.lastSync } : {}),
        ...(this.filteredLastHour ? { metricsLastHour: this.filteredLastHour } : {}),
        ...extra,
      },
    };
  }
}

function safeJson(s: string | undefined): unknown {
  if (!s) return undefined;
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}
