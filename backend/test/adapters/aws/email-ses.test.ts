// email=ses：端口契约 + 驱动细节（同一份 MIME 经 SendEmail Raw 发出、保留域名、抑制、沙盒拒信与 EMAIL_SANDBOX_POLICY、限速、
// 反馈队列的 SES 事件处理、探针、功能对照）。SES 由 aws-sdk-client-mock 拦截，SQS 用内存替身（fake-sqs），不发出任何网络请求。
import {
  GetAccountCommand, GetEmailIdentityCommand, SendEmailCommand, SESv2Client, type GetAccountCommandOutput,
} from '@aws-sdk/client-sesv2';
import { mockClient, type AwsClientStub } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { lazyAwsClients } from '../../../src/adapters/aws/clients.js';
import { compareEmailDrivers } from '../../../src/adapters/email/compare.js';
import { applySesFeedback, deliveryStatusOf, parseSesFeedback, userStatusOf } from '../../../src/adapters/email/feedback.js';
import { buildMime, OutboxEmail } from '../../../src/adapters/email/outbox.js';
import { isReservedAddress } from '../../../src/adapters/email/reserved.js';
import { emailTagsOf, isSesThrottle, SesEmail, SIMULATOR_SUCCESS } from '../../../src/adapters/email/ses.js';
import type { AdapterDeps } from '../../../src/adapters/types.js';
import { createRequestContext, runWithContext } from '../../../src/observability/request-context.js';
import { createUserWithDefaults } from '../../../src/services/user-directory.js';
import { describeEmailContract } from '../../contract/email-notifier.contract.js';
import { makeLocalDeps, type LocalDeps } from '../../contract/_local-deps.js';
import { ENABLE } from '../../helpers/config.js';
import { FakeSqs } from './fake-sqs.js';
import { awsError, fakeCredentials, silentLogger, testConfig, waitFor } from './helpers.js';

const FEEDBACK = 'https://sqs.ap-northeast-1.amazonaws.com/123456789012/cloudalbum-lab-email-feedback';
const FEEDBACK_DLQ = 'https://sqs.ap-northeast-1.amazonaws.com/123456789012/cloudalbum-lab-email-feedback-dlq';
const ME = 'learner@mail.test-only.dev';

let ses: AwsClientStub<SESv2Client>;
let sqs: FakeSqs;
let local: LocalDeps | undefined;

const SANDBOX: GetAccountCommandOutput = {
  $metadata: {}, SendingEnabled: true, ProductionAccessEnabled: false, EnforcementStatus: 'HEALTHY',
  SendQuota: { Max24HourSend: 200, MaxSendRate: 1, SentLast24Hours: 37 },
};

beforeEach(() => {
  ses = mockClient(SESv2Client);
  let n = 0;
  ses.on(SendEmailCommand).callsFake(() => ({ MessageId: `ses-${(n += 1)}` }));
  ses.on(GetAccountCommand).resolves(SANDBOX);
  ses.on(GetEmailIdentityCommand).resolves({ IdentityType: 'EMAIL_ADDRESS', VerifiedForSendingStatus: true, VerificationStatus: 'SUCCESS', DkimAttributes: { Status: 'NOT_STARTED' } });
  sqs = new FakeSqs();
  sqs.createQueue(FEEDBACK_DLQ);
  sqs.createQueue(FEEDBACK, { dlqUrl: FEEDBACK_DLQ, maxReceiveCount: 5, visibilityTimeoutSec: 30 });
});

afterEach(async () => {
  ses.restore();
  sqs.restore();
  await local?.close();
  local = undefined;
});

async function setup(extra: Record<string, string> = {}): Promise<{ deps: AdapterDeps; port: SesEmail; l: LocalDeps }> {
  const l = await makeLocalDeps();
  local = l;
  const { cfg, effective } = testConfig({
    ...ENABLE.iamRole, ...ENABLE.email, EMAIL_FROM: 'CloudAlbum <learner@mail.test-only.dev>', SES_IDENTITY: ME,
    SES_CONFIGURATION_SET: 'cloudalbum-lab-email', SES_FEEDBACK_QUEUE_URL: FEEDBACK, EMAIL_SEND_RATE_PER_SEC: '1000', ...extra,
  });
  const deps: AdapterDeps = { ...l.deps, cfg, env: effective, logger: silentLogger, aws: lazyAwsClients({ region: cfg.core.AWS_REGION, credentials: fakeCredentials }) };
  return { deps, port: new SesEmail(deps), l };
}

describeEmailContract('ses', async () => {
  const { port } = await setup();
  return { port };
});

describe('SesEmail.send', () => {
  it('同一份 MIME 经 SendEmail(Raw) 发出：From / 配置集 / category 标签；记一行 transport=ses（不存正文）；路径段 ses:sent', async () => {
    const { port, l } = await setup();
    const u = await createUserWithDefaults(l.db, { email: 'Friend@Mail.test-only.dev', displayName: 'f', passwordHash: null });
    const ctx = createRequestContext();
    const r = await runWithContext(ctx, () => port.send({ to: ['Friend@Mail.test-only.dev'], subject: '你好', text: '正文', html: '<p>正文</p>', category: 'notification', tags: { event: 'comment.created' } }));
    expect(r).toMatchObject({ transport: 'ses', delivered: true });
    expect(ctx.path.get('email')).toBe('ses:sent');
    const input = ses.commandCalls(SendEmailCommand)[0]!.args[0].input;
    expect(input).toMatchObject({
      FromEmailAddress: 'CloudAlbum <learner@mail.test-only.dev>', Destination: { ToAddresses: ['friend@mail.test-only.dev'] },
      ConfigurationSetName: 'cloudalbum-lab-email', EmailTags: [{ Name: 'category', Value: 'notification' }, { Name: 'event', Value: 'comment_created' }],
    });
    const raw = Buffer.from(input.Content!.Raw!.Data!).toString('utf8');
    expect(raw).toContain('X-CloudAlbum-Transport: ses');
    expect(raw).toContain(`Message-ID: <${r.messageId}@mail.test-only.dev>`);
    const row = await l.db('outbox_emails').where({ message_id: r.messageId }).first();
    expect(row).toMatchObject({ transport: 'ses', status: 'sent', provider_message_id: 'ses-1', user_id: u.id, eml_path: null, delivery_status: 'none' });
    expect(await port.listRecent(5)).toMatchObject([{ messageId: r.messageId, status: 'sent', category: 'notification' }]);
  });

  it('与 outbox 驱动的 MIME 只差 X-CloudAlbum-Transport 一行', () => {
    const base = { from: 'a@b.test', messageId: 'M1', date: new Date('2026-10-14T00:00:00Z'), to: ['x@y.test'], subject: 's', text: 't', html: '<b>t</b>', category: 'system' as const };
    const a = buildMime({ ...base, transport: 'outbox' }).split('\r\n');
    const b = buildMime({ ...base, transport: 'ses' }).split('\r\n');
    expect(a.filter((line, i) => line !== b[i])).toEqual(['X-CloudAlbum-Transport: outbox']);
  });

  it('保留域名（example.com、.test 等）不调用 SES，写进本机 outbox 并标注“保留域名，未发送”（PM-46）', async () => {
    const { port, l } = await setup();
    const ctx = createRequestContext();
    const r = await runWithContext(ctx, () => port.send({ to: ['atl-admin@example.com'], subject: 's', text: 't', category: 'system' }));
    expect(r).toMatchObject({ transport: 'outbox', delivered: false });
    expect(ctx.path.get('email')).toBe('outbox:reserved');
    expect(ses.commandCalls(SendEmailCommand)).toHaveLength(0);
    const row = await l.db('outbox_emails').where({ message_id: r.messageId }).first();
    expect(row.error).toContain('保留域名，未发送');
    expect(port.readBody(row)?.text).toBe('t');
    for (const a of ['x@example.com', 'x@sub.example.org', 'x@foo.test', 'x@a.invalid', 'x@h.localhost', 'Name <x@corp.example>']) expect(isReservedAddress(a), a).toBe(true);
    for (const a of ['x@example.co.jp', 'success@simulator.amazonses.com', 'x@test.com', 'nonsense']) expect(isReservedAddress(a), a).toBe(false);
  });

  it('沙盒拒信（MessageRejected）：EMAIL_SANDBOX_POLICY=fail → 记 failed、ses:rejected、不抛出；probe 报“被拒”', async () => {
    const { port, l } = await setup();
    ses.on(SendEmailCommand).rejects(awsError('MessageRejected', 400, 'Email address is not verified. The following identities failed the check: x@mail.test-only.dev'));
    const ctx = createRequestContext();
    const r = await runWithContext(ctx, () => port.send({ to: ['x@mail.test-only.dev'], subject: 's', text: 't', category: 'verification' }));
    expect(r).toMatchObject({ transport: 'ses', delivered: false });
    expect(ctx.path.get('email')).toBe('ses:rejected');
    expect(await l.db('outbox_emails').where({ message_id: r.messageId }).first()).toMatchObject({ status: 'failed', transport: 'ses', error: expect.stringContaining('MessageRejected') });
    const p = await port.probe();
    expect(p.detail).toContain('最近 5 分钟有 1 封被拒');
  });

  it('EMAIL_SANDBOX_POLICY=outbox：被拒的邮件改写进本机 outbox（.eml 可读），同样标注未真正发出', async () => {
    const { port, l } = await setup({ EMAIL_SANDBOX_POLICY: 'outbox' });
    ses.on(SendEmailCommand).rejects(awsError('MessageRejected', 400, 'Email address is not verified.'));
    const ctx = createRequestContext();
    const r = await runWithContext(ctx, () => port.send({ to: ['new@mail.test-only.dev'], subject: '验证', text: 'code 123', category: 'verification' }));
    expect(r).toMatchObject({ transport: 'outbox', delivered: false });
    expect(ctx.path.get('email')).toBe('ses:rejected');
    const row = await l.db('outbox_emails').where({ message_id: r.messageId }).first();
    expect(row).toMatchObject({ transport: 'outbox' });
    expect(row.error).toContain('EMAIL_SANDBOX_POLICY=outbox');
    expect(port.readBody(row)?.text).toBe('code 123');
  });

  it('抑制：email_status=bounced 的地址只发 verification / password-reset；其他类别跳过（ses:suppressed）', async () => {
    const { port, l } = await setup();
    await createUserWithDefaults(l.db, { email: 'bad@mail.test-only.dev', displayName: 'b', passwordHash: null });
    await l.db('users').where({ email: 'bad@mail.test-only.dev' }).update({ email_status: 'bounced' });
    const ctx = createRequestContext();
    const r = await runWithContext(ctx, () => port.send({ to: ['bad@mail.test-only.dev'], subject: 's', text: 't', category: 'notification' }));
    expect(r).toMatchObject({ transport: 'ses', delivered: false });
    expect(ctx.path.get('email')).toBe('ses:suppressed');
    expect(ses.commandCalls(SendEmailCommand)).toHaveLength(0);
    expect(await l.db('outbox_emails').where({ message_id: r.messageId }).first()).toMatchObject({ status: 'failed', error: expect.stringContaining('ses:suppressed') });
    expect((await port.send({ to: ['bad@mail.test-only.dev'], subject: 's', text: 't', category: 'password-reset' })).delivered).toBe(true);
  });

  it('节流（TooManyRequestsException / Throttling，api 与 worker 合计超过 MaxSendRate）：SES 未接受这封邮件，退避后重试成功（wave1-fix）', async () => {
    const { port } = await setup();
    ses.on(SendEmailCommand)
      .rejectsOnce(awsError('TooManyRequestsException', 429, 'Maximum sending rate exceeded.'))
      .resolves({ MessageId: 'ses-after-throttle' });
    const ctx = createRequestContext();
    const r = await runWithContext(ctx, () => port.send({ to: ['v@mail.test-only.dev'], subject: '验证', text: 'code', category: 'verification' }));
    expect(r).toMatchObject({ transport: 'ses', delivered: true });
    expect(ctx.path.get('email')).toBe('ses:sent');
    expect(ses.commandCalls(SendEmailCommand)).toHaveLength(2);
    expect(isSesThrottle(awsError('Throttling', 400, 'Maximum sending rate exceeded.'))).toBe(true);
    expect(isSesThrottle(awsError('MessageRejected', 400))).toBe(false);
  }, 10_000);

  it('其他错误（5xx）：记 failed、ses:error，不抛出（非权威端口）', async () => {
    const { port } = await setup();
    ses.on(SendEmailCommand).rejects(awsError('InternalFailure', 500));
    const ctx = createRequestContext();
    expect(await runWithContext(ctx, () => port.send({ to: ['y@mail.test-only.dev'], subject: 's', text: 't', category: 'system' }))).toMatchObject({ delivered: false });
    expect(ctx.path.get('email')).toBe('ses:error');
  });

  it('限速：EMAIL_SEND_RATE_PER_SEC=20 时 4 封至少间隔 150 ms', async () => {
    const { port } = await setup({ EMAIL_SEND_RATE_PER_SEC: '20' });
    const t0 = Date.now();
    await Promise.all([1, 2, 3, 4].map((n) => port.send({ to: [`r${n}@mail.test-only.dev`], subject: 's', text: 't', category: 'system' })));
    expect(Date.now() - t0).toBeGreaterThanOrEqual(140);
  });

  it('EmailTags 的名称与值只保留 [A-Za-z0-9_-]，最多 5 个', () => {
    expect(emailTagsOf({ category: 'report', tags: { 'event id': 'a.b:c', b: '1', c: '2', d: '3', e: '4', f: '5' } })).toEqual([
      { Name: 'category', Value: 'report' }, { Name: 'event_id', Value: 'a_b_c' }, { Name: 'b', Value: '1' }, { Name: 'c', Value: '2' }, { Name: 'd', Value: '3' },
    ]);
  });
});

const sesEvent = (eventType: string, messageId: string, extra: Record<string, unknown> = {}) => JSON.stringify({
  eventType, mail: { messageId, destination: ['bounce@simulator.amazonses.com'], tags: { category: ['password-reset'] } }, ...extra,
});

describe('反馈队列（SES 事件 → SNS → SQS）', () => {
  it('consume()：投递 → delivered；硬退信 → bounced 且用户 email_status=bounced；投诉 → complained；软退信只记录；不降级；非 SES 事件留给 DLQ', async () => {
    const { port, l } = await setup();
    const sent = async (to: string) => (await port.send({ to: [to], subject: 's', text: 't', category: 'password-reset' })).messageId;
    for (const a of ['success@simulator.amazonses.com', 'bounce@simulator.amazonses.com', 'complaint@simulator.amazonses.com', 'ooto@simulator.amazonses.com']) {
      await createUserWithDefaults(l.db, { email: a, displayName: a.split('@')[0]!, passwordHash: null });
    }
    const ids = { ok: await sent('success@simulator.amazonses.com'), bounce: await sent('bounce@simulator.amazonses.com'), complaint: await sent('complaint@simulator.amazonses.com'), soft: await sent('ooto@simulator.amazonses.com') };
    const provider = async (id: string) => (await l.db('outbox_emails').where({ message_id: id }).first()).provider_message_id as string;
    sqs.send(FEEDBACK, sesEvent('Delivery', await provider(ids.ok), { delivery: { recipients: ['success@simulator.amazonses.com'] } }));
    sqs.send(FEEDBACK, sesEvent('Bounce', await provider(ids.bounce), { bounce: { bounceType: 'Permanent', bouncedRecipients: [{ emailAddress: 'bounce@simulator.amazonses.com' }] } }));
    sqs.send(FEEDBACK, sesEvent('Delivery', await provider(ids.complaint)));
    sqs.send(FEEDBACK, sesEvent('Complaint', await provider(ids.complaint), { complaint: { complainedRecipients: [{ emailAddress: 'complaint@simulator.amazonses.com' }] } }));
    sqs.send(FEEDBACK, sesEvent('Delivery', await provider(ids.complaint)));   // 迟到的投递事件不能把 complained 降级
    // SNS 信封（未开原始消息传递）也能处理
    sqs.send(FEEDBACK, JSON.stringify({ Type: 'Notification', TopicArn: 'arn:aws:sns:ap-northeast-1:123456789012:t', Message: sesEvent('Bounce', await provider(ids.soft), { bounce: { bounceType: 'Transient', bouncedRecipients: [{ emailAddress: 'ooto@simulator.amazonses.com' }] } }) }));
    sqs.send(FEEDBACK, '{"hello":"world"}');
    const ac = new AbortController();
    const running = port.consume({ signal: ac.signal });
    try {
      await waitFor(() => port.feedbackStats.received >= 7);
    } finally {
      ac.abort();
      await running;
    }
    const status = async (id: string) => (await l.db('outbox_emails').where({ message_id: id }).first()).delivery_status as string;
    expect(await status(ids.ok)).toBe('delivered');
    expect(await status(ids.bounce)).toBe('bounced');
    expect(await status(ids.complaint)).toBe('complained');
    expect(await status(ids.soft)).toBe('delayed');
    const users = Object.fromEntries((await l.db('users').select('email', 'email_status')).map((u: { email: string; email_status: string }) => [u.email, u.email_status]));
    expect(users).toMatchObject({
      'success@simulator.amazonses.com': 'ok', 'bounce@simulator.amazonses.com': 'bounced', 'complaint@simulator.amazonses.com': 'complained', 'ooto@simulator.amazonses.com': 'ok',
    });
    expect(port.feedbackStats.failed).toBe(1);
    expect(sqs.queues.get(FEEDBACK)!.messages.map((m) => m.body)).toEqual(['{"hello":"world"}']);
    // 退信之后，通知类邮件被抑制
    expect(await port.send({ to: ['bounce@simulator.amazonses.com'], subject: 's', text: 't', category: 'notification' })).toMatchObject({ delivered: false });
  });

  it('parseSesFeedback / deliveryStatusOf / userStatusOf；applySesFeedback 幂等', async () => {
    const f = parseSesFeedback(sesEvent('Reject', 'm-1', { reject: { reason: 'Bad content' } }))!;
    expect(f).toMatchObject({ kind: 'reject', messageId: 'm-1', tags: { category: 'password-reset' } });
    expect(deliveryStatusOf(f)).toBe('rejected');
    expect(userStatusOf(f)).toBeNull();
    expect(parseSesFeedback(sesEvent('Open', 'm-2'))).toMatchObject({ kind: 'ignored' });
    expect(parseSesFeedback(JSON.stringify({ notificationType: 'Bounce', mail: { messageId: 'm-3' }, bounce: { bounceType: 'Permanent', bouncedRecipients: [{ emailAddress: 'A@B.test' }] } })))
      .toMatchObject({ kind: 'bounce', recipients: ['a@b.test'] });
    expect(parseSesFeedback('nope')).toBeNull();
    const { l } = await setup();
    const evt = parseSesFeedback(sesEvent('Delivery', 'unknown-id'))!;
    expect(await applySesFeedback(l.db, evt)).toEqual({ kind: 'delivery', rows: 0, users: 0 });
  });
});

describe('SesEmail.probe', () => {
  it('沙盒 → degraded，detail 以“沙盒：只能发给已验证地址 · 今日已发 n / 上限 m”开头（上限取自 GetAccount）', async () => {
    const { port } = await setup();
    const r = await port.probe();
    expect(r.status).toBe('degraded');
    expect(r.detail.startsWith('沙盒：只能发给已验证地址 · 今日已发 37 / 上限 200')).toBe(true);
    expect(r.data).toMatchObject({ verified: true, account: { production: false, sentLast24Hours: 37, max24HourSend: 200 }, feedback: { depth: 0, dlqDepth: 0 } });
  });

  it('生产访问 → ok；反馈 DLQ 有消息 → degraded；身份未验证 / 发送暂停 / 身份不存在 → error；限流 → degraded + transient', async () => {
    const { port } = await setup();
    ses.on(GetAccountCommand).resolves({ ...SANDBOX, ProductionAccessEnabled: true, SendQuota: { Max24HourSend: 50000, SentLast24Hours: 5, MaxSendRate: 14 } });
    let r = await port.probe();
    expect(r).toMatchObject({ status: 'ok', detail: `生产访问 · 今日已发 5 / 上限 50000 · 身份 ${ME}（邮箱） · 反馈队列 0` });
    sqs.send(FEEDBACK_DLQ, '{}');
    expect((await port.probe()).detail).toContain('反馈 DLQ 有 1 条');
    ses.on(GetEmailIdentityCommand).resolves({ IdentityType: 'EMAIL_ADDRESS', VerifiedForSendingStatus: false, VerificationStatus: 'PENDING' });
    r = await port.probe();
    expect(r).toMatchObject({ status: 'error', detail: expect.stringContaining('尚未验证（PENDING') });
    ses.on(GetAccountCommand).resolves({ ...SANDBOX, SendingEnabled: false });
    expect((await port.probe()).detail).toContain('SendingEnabled=false');
    ses.on(GetEmailIdentityCommand).rejects(awsError('NotFoundException', 404));
    expect((await port.probe()).detail).toContain('不存在');
    ses.on(GetEmailIdentityCommand).rejects(awsError('TooManyRequestsException', 429));
    expect(await port.probe()).toMatchObject({ status: 'degraded', transient: true });
  }, 15_000);

  it('深度探针：向 SES 邮箱模拟器发探针邮件；回流为“已投递”后下一次深度探针报告 previousDelivered=true', async () => {
    const { port, l } = await setup();
    const r1 = await port.probe({ deep: true });
    expect(ses.commandCalls(SendEmailCommand)[0]!.args[0].input.Destination).toEqual({ ToAddresses: [SIMULATOR_SUCCESS] });
    const sent = (r1.data as { probeMail: { sent: string } }).probeMail.sent;
    await l.db('outbox_emails').where({ message_id: sent }).update({ delivery_status: 'delivered' });
    const r2 = await port.probe({ deep: true });
    expect(r2.data).toMatchObject({ probeMail: { previousDelivered: true } });
    expect(ses.commandCalls(SendEmailCommand)).toHaveLength(1);   // 10 分钟内不重复发
  });
});

describe('compareEmailDrivers', () => {
  it('同一封邮件经 outbox 与 ses 各发一次；outbox 档只跑一侧；地址无效 → 400', async () => {
    const { port, deps, l } = await setup();
    const r = await compareEmailDrivers(deps, port, ' Me@Mail.test-only.dev ');
    expect(r).toMatchObject({ to: 'me@mail.test-only.dev', reserved: false, outbox: { transport: 'outbox', delivered: false }, ses: { transport: 'ses', delivered: true } });
    expect(await l.db('outbox_emails')).toHaveLength(2);
    const outboxOnly = await compareEmailDrivers(deps, new OutboxEmail(deps), 'me@mail.test-only.dev');
    expect(outboxOnly.ses).toEqual({ skipped: expect.stringContaining('EMAIL_DRIVER=outbox') });
    await expect(compareEmailDrivers(deps, port, 'not-an-address')).rejects.toMatchObject({ status: 400 });
  });
});
