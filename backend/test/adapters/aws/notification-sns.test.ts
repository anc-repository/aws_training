// notification=sns：端口契约（内存 SNS + 内存 SQS）+ 驱动细节（发布格式、过滤策略、订阅生命周期、收件队列、状态同步、探针、
// 功能对照与迁移）。所有 AWS 调用都由 aws-sdk-client-mock 拦截（fake-sns / fake-sqs），不发出任何网络请求。
import { GetMetricDataCommand, CloudWatchClient } from '@aws-sdk/client-cloudwatch';
import { GetTopicAttributesCommand, PublishCommand, SubscribeCommand } from '@aws-sdk/client-sns';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { lazyAwsClients } from '../../../src/adapters/aws/clients.js';
import { OutboxEmail } from '../../../src/adapters/email/outbox.js';
import { compareNotificationDrivers } from '../../../src/adapters/notification/compare.js';
import { DbNotifier } from '../../../src/adapters/notification/db.js';
import { parseInboxMessage } from '../../../src/adapters/notification/inbox.js';
import {
  migrateNotificationDown, migrateNotificationUp, planNotificationMigration, verifyNotificationMigration,
} from '../../../src/adapters/notification/migrate.js';
import { buildPublishInput, filterPolicyFor, samePolicy, SnsNotifier, snsSubject } from '../../../src/adapters/notification/sns.js';
import { queueUrlFromArn } from '../../../src/adapters/notification/sqs-poll.js';
import type { AdapterDeps } from '../../../src/adapters/types.js';
import { createRequestContext, runWithContext } from '../../../src/observability/request-context.js';
import type { NotificationEvent } from '../../../src/ports/notifier.js';
import { getNotificationPrefs, setNotificationPrefs } from '../../../src/repositories/notifications.js';
import { createUserWithDefaults } from '../../../src/services/user-directory.js';
import { describeNotifierContract } from '../../contract/email-notifier.contract.js';
import { makeLocalDeps, type LocalDeps } from '../../contract/_local-deps.js';
import { ENABLE } from '../../helpers/config.js';
import { FakeSns } from './fake-sns.js';
import { FakeSqs } from './fake-sqs.js';
import { awsError, fakeCredentials, silentLogger, testConfig, waitFor } from './helpers.js';

const TOPIC = ENABLE.notification.NOTIFY_TOPIC_ARN;
const INBOX = ENABLE.notification.NOTIFY_INBOX_QUEUE_URL;
const DLQ = 'https://sqs.ap-northeast-1.amazonaws.com/123456789012/cloudalbum-lab-notification-dlq';
const INBOX_ARN = 'arn:aws:sqs:ap-northeast-1:123456789012:cloudalbum-lab-notification-inbox';

let sqs: FakeSqs;
let sns: FakeSns;
let local: LocalDeps | undefined;

beforeEach(() => {
  sqs = new FakeSqs();
  sqs.createQueue(DLQ);
  sqs.createQueue(INBOX, { dlqUrl: DLQ, maxReceiveCount: 5, visibilityTimeoutSec: 30 });
  sns = new FakeSns(sqs);
  sns.createTopic(TOPIC);
  // 栈创建的两个订阅：收件队列（原始消息传递、无过滤）与运维兜底邮箱（audience=admin，待确认）
  sns.addSubscription({ topicArn: TOPIC, protocol: 'sqs', endpoint: INBOX_ARN, pending: false, raw: true });
  sns.addSubscription({ topicArn: TOPIC, protocol: 'email', endpoint: 'ops+admin@mail.test-only.dev', pending: true, filterPolicy: { audience: ['admin'] } });
});

afterEach(async () => {
  sns.restore();
  sqs.restore();
  await local?.close();
  local = undefined;
});

async function setup(extra: Record<string, string> = {}): Promise<{ deps: AdapterDeps; port: SnsNotifier; l: LocalDeps }> {
  const l = await makeLocalDeps();
  local = l;
  const { cfg, effective } = testConfig({ ...ENABLE.iamRole, ...ENABLE.notification, NOTIFY_DLQ_URL: DLQ, ...extra });
  const deps: AdapterDeps = {
    ...l.deps, cfg, env: effective, logger: silentLogger,
    aws: lazyAwsClients({ region: cfg.core.AWS_REGION, credentials: fakeCredentials }),
  };
  deps.email = new OutboxEmail(deps);
  return { deps, port: new SnsNotifier(deps), l };
}

const evt = (over: Partial<NotificationEvent> = {}): NotificationEvent => ({
  eventId: `e-${Math.random().toString(36).slice(2, 10)}`, type: 'comment.created', audience: 'user', origin: 'ec2',
  recipientUserId: 'u-1', title: '新评论', body: '有人评论了你的照片', link: '/photos/p1', ...over,
});

describeNotifierContract('sns', async () => {
  const { port, l } = await setup();
  const u = await createUserWithDefaults(l.db, { email: 'contract@mail.test-only.dev', displayName: 'c', passwordHash: null, emailVerified: true });
  return { port, userId: u.id, email: u.email };
});

describe('发布格式（buildPublishInput）', () => {
  it('MessageStructure=json：default / email / sqs 三份文本；消息属性齐全；sqs 是完整事件 JSON', () => {
    const e = evt({ eventId: 'e1', recipientUserId: 'u-9' });
    const input = buildPublishInput(e, TOPIC, 'https://album.example.com/');
    expect(input).toMatchObject({ TopicArn: TOPIC, MessageStructure: 'json' });
    const m = JSON.parse(input.Message!) as Record<string, string>;
    expect(Object.keys(m).sort()).toEqual(['default', 'email', 'sqs']);
    expect(JSON.parse(m.sqs!)).toEqual(e);
    expect(m.email).toContain('https://album.example.com/photos/p1');
    expect(m.email).toContain('Amazon SNS');
    const a = input.MessageAttributes!;
    expect(Object.fromEntries(Object.entries(a).map(([k, v]) => [k, v.StringValue]))).toEqual({
      eventType: 'comment.created', userId: 'u-9', audience: 'user', origin: 'ec2', eventId: 'e1',
    });
    expect(Object.values(a).every((v) => v.DataType === 'String')).toBe(true);
  });

  it('audience=admin 时 userId 属性为 *（SNS 的字符串属性不能为空）', () => {
    const input = buildPublishInput(evt({ audience: 'admin', recipientUserId: '', type: 'report.ready' }), TOPIC, 'http://x');
    expect(input.MessageAttributes!.userId!.StringValue).toBe('*');
    expect(input.MessageAttributes!.audience!.StringValue).toBe('admin');
  });

  it('Subject：中文标题改用英文事件名；ASCII 标题保留；不超过 99 个字符、没有换行', () => {
    expect(snsSubject({ title: '新评论', type: 'comment.created' })).toBe('CloudAlbum: New comment on your photo');
    expect(snsSubject({ title: 'Daily report 2026-10-14', type: 'report.ready' })).toBe('CloudAlbum: Daily report 2026-10-14');
    const long = snsSubject({ title: `x${'y'.repeat(200)}\nz`, type: 'report.ready' });
    expect(long.length).toBeLessThanOrEqual(99);
    expect(long).not.toMatch(/[\r\n]/);
  });

  it('过滤策略：普通用户只按 userId；管理员用 $or 同时匹配 userId 与 audience=admin', () => {
    expect(filterPolicyFor('u1', false)).toEqual({ userId: ['u1'] });
    expect(filterPolicyFor('a1', true)).toEqual({ $or: [{ userId: ['a1'] }, { audience: ['admin'] }] });
    expect(samePolicy({ b: [1], a: { y: 2, x: 1 } }, { a: { x: 1, y: 2 }, b: [1] })).toBe(true);
    expect(samePolicy({ userId: ['u1'] }, { userId: ['u2'] })).toBe(false);
  });
});

describe('SnsNotifier.publish', () => {
  it('一次 Publish → 收件队列收到原始事件；写一行 channel=sns 投递；路径段 notification=sns:published；重复 eventId 不再发布', async () => {
    const { port, l } = await setup();
    const ctx = createRequestContext();
    const e = evt({ eventId: 'pub-1' });
    const r = await runWithContext(ctx, () => port.publish(e));
    expect(r.channels).toEqual(['sns']);
    expect(ctx.path.get('notification')).toBe('sns:published');
    expect(sns.published).toHaveLength(1);
    expect(sqs.depth(INBOX).visible).toBe(1);
    const rows = await l.db('notification_deliveries').where({ event_id: 'pub-1' });
    expect(rows).toMatchObject([{ channel: 'sns', status: 'sent', target: 'cloudalbum-lab-notification-events' }]);
    const again = createRequestContext();
    await runWithContext(again, () => port.publish(e));
    expect(sns.published).toHaveLength(1);
    expect(again.path.get('notification')).toBe('sns:duplicate');
  });

  it('Publish 失败 → 503 NOTIFICATION_UNAVAILABLE、failed 投递行、路径段 sns:error（不回退到逐个发信）', async () => {
    const { port, l } = await setup();
    sns.mock.on(PublishCommand).rejects(awsError('AuthorizationErrorException', 403));
    const ctx = createRequestContext();
    await expect(runWithContext(ctx, () => port.publish(evt({ eventId: 'pub-fail' })))).rejects.toMatchObject({ status: 503, code: 'NOTIFICATION_UNAVAILABLE' });
    expect(ctx.path.get('notification')).toBe('sns:error');
    expect(await l.db('notification_deliveries').where({ event_id: 'pub-fail' })).toMatchObject([{ channel: 'sns', status: 'failed' }]);
    expect(await l.db('outbox_emails')).toHaveLength(0);
  });
});

describe('订阅过滤（本地替身中的完整扇出）', () => {
  it('确认后的用户订阅只收到 userId 匹配的事件；管理员订阅收到自己的与 audience=admin 的广播；收件队列收到全部', async () => {
    const { port, l } = await setup();
    const u1 = await createUserWithDefaults(l.db, { email: 'u1@mail.test-only.dev', displayName: 'u1', passwordHash: null, emailVerified: true });
    const u2 = await createUserWithDefaults(l.db, { email: 'u2@mail.test-only.dev', displayName: 'u2', passwordHash: null, emailVerified: true });
    const a1 = await createUserWithDefaults(l.db, { email: 'a1@mail.test-only.dev', displayName: 'a1', passwordHash: null, role: 'admin', emailVerified: true });
    for (const u of [u1, u2, a1]) {
      expect(await port.subscribeEmail(u.id, u.email)).toEqual({ pendingConfirmation: true });
      sns.confirm(u.email);
    }
    sns.confirm('ops+admin@mail.test-only.dev');
    await port.publish(evt({ eventId: 'f1', recipientUserId: u1.id }));
    await port.publish(evt({ eventId: 'f2', audience: 'admin', recipientUserId: '', type: 'report.ready' }));
    const to = (endpoint: string) => sns.deliveries.filter((d) => d.endpoint === endpoint).length;
    expect(to(u1.email)).toBe(1);
    expect(to(u2.email)).toBe(0);
    expect(to(a1.email)).toBe(1);                       // 广播经 $or 送到管理员
    expect(to('ops+admin@mail.test-only.dev')).toBe(1);   // 运维兜底只收广播
    expect(to(INBOX_ARN)).toBe(2);
    expect(sns.filteredOut).toBeGreaterThan(0);
    // 邮件订阅拿到的是 email 键的纯文本
    expect(sns.deliveries.find((d) => d.endpoint === u1.email)!.body).toContain('有人评论了你的照片');
  });
});

describe('SnsNotifier.subscribeEmail / unsubscribe', () => {
  it('Subscribe：ReturnSubscriptionArn=true、FilterPolicyScope=MessageAttributes；ARN 与 pending 写入 notification_prefs', async () => {
    const { port, l } = await setup();
    const u = await createUserWithDefaults(l.db, { email: 'Sub@Mail.test-only.dev', displayName: 's', passwordHash: null, emailVerified: true });
    const ctx = createRequestContext();
    expect(await runWithContext(ctx, () => port.subscribeEmail(u.id, u.email))).toEqual({ pendingConfirmation: true });
    expect(ctx.path.get('notification')).toBe('sns:subscribe-pending');
    const call = sns.mock.commandCalls(SubscribeCommand)[0]!.args[0].input as unknown as Record<string, unknown>;
    expect(call).toMatchObject({ Protocol: 'email', Endpoint: 'sub@mail.test-only.dev', ReturnSubscriptionArn: true });
    expect(call.Attributes).toEqual({ FilterPolicy: JSON.stringify({ userId: [u.id] }), FilterPolicyScope: 'MessageAttributes' });
    const prefs = await getNotificationPrefs(l.db, u.id);
    expect(prefs).toMatchObject({ emailEnabled: true, snsStatus: 'pending' });
    expect(prefs.snsSubscriptionArn).toMatch(/^arn:aws:sns:/);
    // 确认之后再次开通：不新建订阅，只返回 confirmed
    sns.confirm('sub@mail.test-only.dev');
    expect(await port.subscribeEmail(u.id, u.email)).toEqual({ pendingConfirmation: false });
    expect(sns.subscriptions.filter((s) => s.endpoint === 'sub@mail.test-only.dev')).toHaveLength(1);
    // 关闭
    await port.unsubscribe(u.id);
    expect(sns.subscriptions.filter((s) => s.endpoint === 'sub@mail.test-only.dev')).toHaveLength(0);
    expect(await getNotificationPrefs(l.db, u.id)).toEqual({ emailEnabled: false, snsSubscriptionArn: null, snsStatus: null });
  });

  it('保留域名（example.com 等）不建订阅（PM-46 / PM-M23）', async () => {
    const { port, l } = await setup();
    const u = await createUserWithDefaults(l.db, { email: 'seed@example.com', displayName: 's', passwordHash: null, emailVerified: true });
    const ctx = createRequestContext();
    expect(await runWithContext(ctx, () => port.subscribeEmail(u.id, u.email))).toEqual({ pendingConfirmation: false });
    expect(ctx.path.get('notification')).toBe('sns:reserved');
    expect(sns.mock.commandCalls(SubscribeCommand)).toHaveLength(0);
    expect(await getNotificationPrefs(l.db, u.id)).toMatchObject({ emailEnabled: true, snsSubscriptionArn: null, snsStatus: 'reserved' });
  });

  it('同一地址已用不同过滤策略订阅过（例如角色变了）→ 改写过滤策略，不报错', async () => {
    const { port, l } = await setup();
    const u = await createUserWithDefaults(l.db, { email: 'dup@mail.test-only.dev', displayName: 'd', passwordHash: null, role: 'admin', emailVerified: true });
    sns.addSubscription({ topicArn: TOPIC, protocol: 'email', endpoint: 'dup@mail.test-only.dev', pending: false, filterPolicy: { userId: [u.id] } });
    expect(await port.subscribeEmail(u.id, u.email)).toEqual({ pendingConfirmation: false });
    expect(sns.subscriptions.find((s) => s.endpoint === 'dup@mail.test-only.dev')!.filterPolicy).toEqual(filterPolicyFor(u.id, true));
    expect(await getNotificationPrefs(l.db, u.id)).toMatchObject({ snsStatus: 'confirmed' });
  });

  it('Subscribe 无权限 → 503；订阅已不存在时 unsubscribe 仍成功', async () => {
    const { port, l } = await setup();
    const u = await createUserWithDefaults(l.db, { email: 'gone@mail.test-only.dev', displayName: 'g', passwordHash: null, emailVerified: true });
    await port.subscribeEmail(u.id, u.email);
    sns.remove('gone@mail.test-only.dev');
    await expect(port.unsubscribe(u.id)).resolves.toBeUndefined();
    sns.mock.on(SubscribeCommand).rejects(awsError('AuthorizationErrorException', 403));
    await expect(port.subscribeEmail(u.id, u.email)).rejects.toMatchObject({ status: 503 });
  });
});

describe('收件队列与订阅状态同步（worker）', () => {
  it('consume()：收件队列的每条消息记一行 sqs-copy；origin=lambda 代写站内信；重复到达只记一次；坏消息留给 DLQ', async () => {
    const { port, l } = await setup();
    const owner = await createUserWithDefaults(l.db, { email: 'owner@mail.test-only.dev', displayName: 'o', passwordHash: null, emailVerified: true });
    await port.publish(evt({ eventId: 'ec2-1', recipientUserId: owner.id }));
    await port.publish(evt({ eventId: 'lam-1', origin: 'lambda', recipientUserId: owner.id, title: 'Lambda 评论' }));
    // 至少一次投递：同一事件再到一份
    sqs.send(INBOX, JSON.stringify(evt({ eventId: 'lam-1', origin: 'lambda', recipientUserId: owner.id, title: 'Lambda 评论' })));
    sqs.send(INBOX, 'not-json');
    const ac = new AbortController();
    const running = port.consume({ signal: ac.signal });
    try {
      await waitFor(async () => (await l.db('notification_deliveries').where({ channel: 'sqs-copy' })).length >= 2 && port.inboxStats.received >= 4);
    } finally {
      ac.abort();
      await running;
    }
    expect(await l.db('notification_deliveries').where({ channel: 'sqs-copy' }).orderBy('event_id')).toMatchObject([
      { event_id: 'ec2-1', target: 'inbox' }, { event_id: 'lam-1', target: 'inbox' },
    ]);
    const inbox = await l.db('notifications').where({ user_id: owner.id });
    expect(inbox.map((n: { event_id: string }) => n.event_id)).toEqual(['lam-1']);   // origin=ec2 的站内信由核心服务写，这里不写
    expect(port.inboxStats.failed).toBeGreaterThanOrEqual(1);                          // not-json 留在队列里
    expect(sqs.queues.get(INBOX)!.messages.some((m) => m.body === 'not-json')).toBe(true);
  });

  it('parseInboxMessage：探针消息、SNS 信封、无效消息', () => {
    expect(parseInboxMessage(JSON.stringify({ probe: true, eventId: 'probe:1' }), { probe: { StringValue: 'true' } })).toEqual({ kind: 'probe', eventId: 'probe:1' });
    const e = evt({ eventId: 'env-1' });
    const envelope = JSON.stringify({ Type: 'Notification', TopicArn: TOPIC, Message: JSON.stringify(e) });
    expect(parseInboxMessage(envelope)).toMatchObject({ kind: 'event', event: { eventId: 'env-1' } });
    expect(parseInboxMessage(JSON.stringify({ ...e, type: 'x' }))).toMatchObject({ kind: 'invalid' });
    expect(parseInboxMessage(JSON.stringify({ ...e, audience: 'user', recipientUserId: '' }))).toMatchObject({ kind: 'invalid' });
  });

  it('syncSubscriptions：pending → confirmed；订阅消失 → 关闭邮件通知并写站内信；角色变为管理员 → 改写过滤策略', async () => {
    const { port, l } = await setup();
    const a = await createUserWithDefaults(l.db, { email: 'a@mail.test-only.dev', displayName: 'a', passwordHash: null, emailVerified: true });
    const b = await createUserWithDefaults(l.db, { email: 'b@mail.test-only.dev', displayName: 'b', passwordHash: null, emailVerified: true });
    await port.subscribeEmail(a.id, a.email);
    await port.subscribeEmail(b.id, b.email);
    sns.confirm(a.email);
    sns.confirm(b.email);
    let r = await port.syncSubscriptions();
    expect(r).toMatchObject({ checked: 2, confirmed: 2, removed: 0 });
    expect(await getNotificationPrefs(l.db, a.id)).toMatchObject({ snsStatus: 'confirmed' });
    // b 点了退订链接；a 被设为管理员
    sns.remove(b.email);
    await l.db('users').where({ id: a.id }).update({ role: 'admin' });
    r = await port.syncSubscriptions();
    expect(r).toMatchObject({ removed: 1, filterUpdated: 1 });
    expect(await getNotificationPrefs(l.db, b.id)).toEqual({ emailEnabled: false, snsSubscriptionArn: null, snsStatus: 'unsubscribed' });
    expect(await l.db('notifications').where({ user_id: b.id })).toMatchObject([{ type: 'notification.unsubscribed', title: '邮件通知已关闭' }]);
    expect(sns.subscriptions.find((s) => s.endpoint === a.email)!.filterPolicy).toEqual(filterPolicyFor(a.id, true));
    // 幂等：再同步一次没有变化
    expect(await port.syncSubscriptions()).toMatchObject({ confirmed: 0, removed: 0, filterUpdated: 0 });
  });
});

describe('SnsNotifier.probe', () => {
  it('运维订阅待确认 → degraded，detail 含“订阅待确认”；确认后 ok；用户订阅待确认不影响状态', async () => {
    const { port, l } = await setup();
    const u = await createUserWithDefaults(l.db, { email: 'p@mail.test-only.dev', displayName: 'p', passwordHash: null, emailVerified: true });
    await port.subscribeEmail(u.id, u.email);
    let r = await port.probe();
    expect(r.status).toBe('degraded');
    expect(r.detail).toContain('订阅待确认');
    expect(r.data).toMatchObject({ subscriptions: { opsPending: 1, emailPending: 2, users: 1, inboxSubscribed: true }, dlqDepth: 0 });
    sns.confirm('ops+admin@mail.test-only.dev');
    r = await port.probe();
    expect(r.status).toBe('ok');
    expect(r.detail).toMatch(/^主题 cloudalbum-lab-notification-events · 已确认订阅 2 · 待确认 1 · 收件队列 0 · 订阅级 DLQ 0$/);
  });

  it('订阅级 DLQ 有消息 → degraded；主题不存在 → error；限流 / 超时 → degraded + transient', async () => {
    const { port } = await setup();
    sns.confirm('ops+admin@mail.test-only.dev');
    sqs.send(DLQ, '{}');
    expect((await port.probe()).detail).toContain('订阅级 DLQ 有 1 条');
    sns.mock.on(GetTopicAttributesCommand).rejects(awsError('NotFoundException', 404, 'Topic does not exist'));
    expect(await port.probe()).toMatchObject({ status: 'error', detail: expect.stringContaining('主题或收件队列不存在') });
    sns.mock.on(GetTopicAttributesCommand).rejects(awsError('Throttling', 400, 'Rate exceeded'));
    expect(await port.probe()).toMatchObject({ status: 'degraded', transient: true });
  }, 15_000);

  it('深度探针：读 CloudWatch 的被过滤数，并发布 probe=true 的探针消息（只进收件队列）', async () => {
    const { port } = await setup();
    sns.confirm('ops+admin@mail.test-only.dev');
    const cw = mockClient(CloudWatchClient);
    cw.on(GetMetricDataCommand).resolves({ MetricDataResults: [{ Id: 'filtered', Values: [10, 8] }, { Id: 'failed', Values: [] }, { Id: 'delivered', Values: [3] }] });
    try {
      const r = await port.probe({ deep: true });
      expect(r.status).toBe('ok');
      expect(r.detail).toContain('最近 1 小时被过滤 18');
      expect(r.data).toMatchObject({ metricsLastHour: { filtered: 18, failed: 0, delivered: 3 }, probeMessage: { published: expect.stringMatching(/^probe:/) } });
      const probeMsg = sns.published.at(-1)!;
      expect(probeMsg.attributes.probe!.StringValue).toBe('true');
      expect(sns.deliveries.filter((d) => d.protocol === 'email')).toHaveLength(0);   // 过滤策略挡住了所有邮件订阅
      expect(sqs.depth(INBOX).visible).toBe(1);
    } finally {
      cw.restore();
    }
  });
});

describe('功能对照与迁移', () => {
  it('compareNotificationDrivers：db 驱动逐个发给每位管理员（不写站内信）；sns 驱动一次 Publish', async () => {
    const { port, deps, l } = await setup();
    for (const n of [1, 2, 3]) await createUserWithDefaults(l.db, { email: `adm${n}@mail.test-only.dev`, displayName: 'a', passwordHash: null, role: 'admin', emailVerified: true });
    const r = await compareNotificationDrivers(deps, port);
    expect(r.recipients).toBe(3);
    expect(r.db).toMatchObject({ calls: 3, channels: ['email'], emailTransport: 'outbox' });
    expect(r.sns).toMatchObject({ calls: 1, channels: ['sns'] });
    expect(sns.published).toHaveLength(1);
    expect(await l.db('outbox_emails')).toHaveLength(3);
    expect(await l.db('notifications')).toHaveLength(0);
    const dbOnly = await compareNotificationDrivers(deps, new DbNotifier(deps));
    expect(dbOnly.sns).toEqual({ skipped: expect.stringContaining('NOTIFY_DRIVER=db') });
  });

  it('迁移 up / down / verify：为开启了邮件通知的用户建订阅（保留域名除外），down 删除订阅但保留开关', async () => {
    const { port, l } = await setup();
    const u1 = await createUserWithDefaults(l.db, { email: 'm1@mail.test-only.dev', displayName: 'm1', passwordHash: null, emailVerified: true });
    const u2 = await createUserWithDefaults(l.db, { email: 'm2@example.com', displayName: 'm2', passwordHash: null, emailVerified: true });
    const u3 = await createUserWithDefaults(l.db, { email: 'm3@mail.test-only.dev', displayName: 'm3', passwordHash: null, emailVerified: true });
    for (const u of [u1, u2]) await setNotificationPrefs(l.db, u.id, { emailEnabled: true });
    await setNotificationPrefs(l.db, u3.id, { emailEnabled: false });
    expect(await planNotificationMigration(l.db)).toMatchObject({ items: 1 });
    expect(await verifyNotificationMigration(l.db, 'up')).toMatchObject({ ok: false });
    expect(await migrateNotificationUp(l.db, port)).toMatchObject({ copied: 1, skipped: 1, failed: 0 });
    expect(await migrateNotificationUp(l.db, port)).toMatchObject({ copied: 0, skipped: 2 });   // 幂等
    expect(await verifyNotificationMigration(l.db, 'up')).toEqual({ ok: true, mismatches: [] });
    expect(sns.subscriptions.filter((s) => s.protocol === 'email' && s.endpoint !== 'ops+admin@mail.test-only.dev').map((s) => s.endpoint)).toEqual(['m1@mail.test-only.dev']);
    expect(await migrateNotificationDown(l.db, port)).toMatchObject({ copied: 1, failed: 0 });
    expect(await verifyNotificationMigration(l.db, 'down')).toEqual({ ok: true, mismatches: [] });
    expect(await getNotificationPrefs(l.db, u1.id)).toMatchObject({ emailEnabled: true, snsSubscriptionArn: null });
  });

  it('queueUrlFromArn', () => {
    expect(queueUrlFromArn('arn:aws:sqs:ap-northeast-1:123456789012:q-dlq')).toBe('https://sqs.ap-northeast-1.amazonaws.com/123456789012/q-dlq');
    expect(queueUrlFromArn('arn:aws:sqs:us-east-1:123456789012:q', 'http://localhost:4566/')).toBe('http://localhost:4566/123456789012/q');
    expect(queueUrlFromArn('nope')).toBeUndefined();
  });
});
