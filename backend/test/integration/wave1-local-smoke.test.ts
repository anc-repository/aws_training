// wave1-integration：notification(sns)、email(ses)、logging(cloudwatch)、monitoring(cloudwatch) 的本地集成冒烟。
//
// 本机没有 LocalStack 镜像（并行阶段与集成阶段都不拉取镜像），改用本地替身：内存 SNS / SQS / CloudWatch Logs（test/adapters/aws/fake-*.ts）
// 与 aws-sdk-client-mock 的 SES v2、CloudWatch、STS、IAM。不同于各驱动的单元测试，这里走完整的装配链：
//   modules.d/*.env（与 scripts/module enable 写出的键相同，栈输出换成真实形状的值）→ 分层加载 + zod + 规则引擎 → container（api 与 worker
//   两个进程角色，共用同一个 SQLite）→ createApp 的 HTTP 流程 → worker.ts 的 startWorkerLoops（队列消费者）→ X-CloudAlbum-Path 与 capabilities。
// 不发出任何网络请求（IAM_CREDENTIALS=keys 的测试密钥只交给 mock）。
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CloudWatchClient, DescribeAlarmsCommand, GetMetricDataCommand, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { GetUserCommand, IAMClient } from '@aws-sdk/client-iam';
import { GetAccountCommand, GetEmailIdentityCommand, SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { mockClient } from 'aws-sdk-client-mock';
import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parsePathHeader } from '@cloudalbum/contracts';
import { buildContainer, type Container } from '../../src/container.js';
import { createApp } from '../../src/http/app.js';
import type { Principal } from '../../src/ports/auth.js';
import { insertPhoto } from '../../src/repositories/photos.js';
import { startWorkerLoops } from '../../src/worker.js';
import { FakeCwLogs } from '../adapters/aws/fake-cwlogs.js';
import { FakeSns } from '../adapters/aws/fake-sns.js';
import { FakeSqs } from '../adapters/aws/fake-sqs.js';
import { tempEnvDir } from '../helpers/config.js';
import { l0Secrets } from '../helpers/identity-harness.js';
import { seedAlbum, seedUser, waitFor } from '../helpers/media-fixtures.js';

const ACCOUNT = '123456789012';
const TOPIC = `arn:aws:sns:ap-northeast-1:${ACCOUNT}:cloudalbum-lab-notification-events`;
const INBOX = `https://sqs.ap-northeast-1.amazonaws.com/${ACCOUNT}/cloudalbum-lab-notification-inbox`;
const INBOX_ARN = `arn:aws:sqs:ap-northeast-1:${ACCOUNT}:cloudalbum-lab-notification-inbox`;
const NOTIFY_DLQ = `https://sqs.ap-northeast-1.amazonaws.com/${ACCOUNT}/cloudalbum-lab-notification-dlq`;
const FEEDBACK = `https://sqs.ap-northeast-1.amazonaws.com/${ACCOUNT}/cloudalbum-lab-email-feedback`;
const FEEDBACK_DLQ = `https://sqs.ap-northeast-1.amazonaws.com/${ACCOUNT}/cloudalbum-lab-email-feedback-dlq`;
const ALARM_TOPIC = `arn:aws:sns:ap-northeast-1:${ACCOUNT}:cloudalbum-lab-ops-alarms`;

/** scripts/module enable 写出的 modules.d 键（scratchpad 中 --dry-run 的计划核对过键名），栈输出换成真实形状的值 */
const MODULES = {
  iam: { MODULE_IAM: 'on', MODULE_IAM_VERSION: '1', IAM_CREDENTIALS: 'keys' },
  notification: {
    MODULE_NOTIFICATION: 'on', MODULE_NOTIFICATION_VERSION: '1', NOTIFY_DRIVER: 'sns', NOTIFY_TOPIC_ARN: TOPIC,
    NOTIFY_INBOX_QUEUE_URL: INBOX, NOTIFY_DLQ_URL: NOTIFY_DLQ,
  },
  email: {
    MODULE_EMAIL: 'on', MODULE_EMAIL_VERSION: '1', EMAIL_DRIVER: 'ses', EMAIL_FROM: 'CloudAlbum <ops@mail.test-only.dev>',
    SES_IDENTITY: 'ops@mail.test-only.dev', SES_CONFIGURATION_SET: 'cloudalbum-lab-email', SES_FEEDBACK_QUEUE_URL: FEEDBACK,
    EMAIL_FOR_COGNITO: 'off', EMAIL_SANDBOX_POLICY: 'fail', EMAIL_SEND_RATE_PER_SEC: '10',
  },
  logging: {
    MODULE_LOGGING: 'on', MODULE_LOGGING_VERSION: '1', LOG_DRIVER: 'cloudwatch', LOG_CW_SHIPPER: 'sdk',
    LOG_CW_GROUP_APP: '/cloudalbum/lab/app', LOG_CW_GROUP_NGINX: '/cloudalbum/lab/nginx', LOG_CW_RETENTION_DAYS: '14',
  },
  monitoring: {
    MODULE_MONITORING: 'on', MODULE_MONITORING_VERSION: '1', METRICS_DRIVER: 'cloudwatch', METRICS_CW_MODE: 'putmetricdata',
    METRICS_CW_NAMESPACE: 'CloudAlbum/App', METRICS_CW_FLUSH_SEC: '60', METRICS_CW_EMF_ENDPOINT: 'tcp://127.0.0.1:25888',
    METRICS_CW_ALARM_TOPIC_ARN: ALARM_TOPIC, METRICS_CW_ALARM_PREFIX: 'cloudalbum-lab-', METRICS_CW_DASHBOARD: 'CloudAlbum-lab-Overview',
  },
};

const sts = mockClient(STSClient);
const iam = mockClient(IAMClient);
const ses = mockClient(SESv2Client);
const cw = mockClient(CloudWatchClient);
let sqs: FakeSqs;
let sns: FakeSns;
let cwl: FakeCwLogs;
let api: Container;
let worker: Container;
let app: Express;
const abort = new AbortController();
let sesSent = 0;

function pathOf(res: request.Response): Record<string, string> {
  const parsed = parsePathHeader(String(res.headers['x-cloudalbum-path'] ?? ''));
  return Object.fromEntries(parsed.modules.map((m) => [m.module, m.raw]));
}

beforeAll(async () => {
  sqs = new FakeSqs();
  for (const dlq of [NOTIFY_DLQ, FEEDBACK_DLQ]) sqs.createQueue(dlq);
  sqs.createQueue(INBOX, { dlqUrl: NOTIFY_DLQ, maxReceiveCount: 5, visibilityTimeoutSec: 30 });
  sqs.createQueue(FEEDBACK, { dlqUrl: FEEDBACK_DLQ, maxReceiveCount: 5, visibilityTimeoutSec: 30 });
  sns = new FakeSns(sqs);
  sns.createTopic(TOPIC);
  sns.createTopic(ALARM_TOPIC);
  sns.addSubscription({ topicArn: TOPIC, protocol: 'sqs', endpoint: INBOX_ARN, pending: false, raw: true });
  sns.addSubscription({ topicArn: ALARM_TOPIC, protocol: 'email', endpoint: 'ops@mail.test-only.dev', pending: false });
  cwl = new FakeCwLogs();
  cwl.createGroup('/cloudalbum/lab/app', 14);
  cwl.createGroup('/cloudalbum/lab/nginx', 14);

  sts.on(GetCallerIdentityCommand).resolves({ Arn: `arn:aws:iam::${ACCOUNT}:user/cloudalbum-lab-demo-keys`, Account: ACCOUNT, UserId: 'AIDAEXAMPLE' });
  iam.on(GetUserCommand).resolves({ User: { UserName: 'cloudalbum-lab-demo-keys', UserId: 'AIDAEXAMPLE', Arn: 'arn', Path: '/', CreateDate: new Date() } });
  ses.on(SendEmailCommand).callsFake(() => ({ MessageId: `ses-${(sesSent += 1)}` }));
  ses.on(GetAccountCommand).resolves({
    ProductionAccessEnabled: false, SendingEnabled: true, EnforcementStatus: 'HEALTHY',
    SendQuota: { Max24HourSend: 200, MaxSendRate: 1, SentLast24Hours: 0 },
  });
  ses.on(GetEmailIdentityCommand).resolves({ IdentityType: 'EMAIL_ADDRESS', VerifiedForSendingStatus: true, VerificationStatus: 'SUCCESS' });
  cw.on(PutMetricDataCommand).resolves({});
  cw.on(DescribeAlarmsCommand).resolves({ MetricAlarms: [], CompositeAlarms: [] });
  cw.on(GetMetricDataCommand).resolves({ MetricDataResults: [] });

  const data = mkdtempSync(path.join(os.tmpdir(), 'cloudalbum-wave1-smoke-'));
  const envDir = tempEnvDir({
    base: { APP_BASE_URL: 'http://localhost:3000', CLOUDALBUM_DATA_DIR: data.replace(/\\/g, '/'), AWS_REGION: 'ap-northeast-1', CLOUDALBUM_ENV: 'lab' },
    modules: MODULES,
    secrets: { ...l0Secrets(), IAM_KEYS_ACCESS_KEY_ID: 'AKIAEXAMPLE', IAM_KEYS_SECRET_ACCESS_KEY: 'secret' },
  });
  api = await buildContainer('api', { envDir, processEnv: { NODE_ENV: 'test' } });
  worker = await buildContainer('worker', { envDir, processEnv: { NODE_ENV: 'test' } });
  Object.defineProperty(api.auth, 'verifyAccessToken', {
    configurable: true, writable: true,
    value: async (token: string): Promise<Principal> => {
      const row = (await api.db('users').where({ id: token }).first('role')) as { role?: string } | undefined;
      return {
        provider: 'local', subject: token, email: `${token}@mail.test-only.dev`, emailVerified: true,
        groups: row?.role === 'admin' ? ['admin'] : [], plan: 'free', expiresAt: Date.now() / 1000 + 3600,
      };
    },
  });
  app = createApp(api);
  await startWorkerLoops(worker, abort.signal);
}, 60_000);

afterAll(async () => {
  abort.abort();
  await worker?.close();
  await api?.close();
  sns?.restore();
  sqs?.restore();
  cwl?.restore();
  sts.restore();
  iam.restore();
  ses.restore();
  cw.restore();
});

describe('wave 1 local integration smoke (local stand-ins, no AWS)', () => {
  it('配置与装配：四个模块的 AWS 驱动被装配，capabilities（管理员视图）显示驱动与状态', async () => {
    await api.capabilities.probeAll({ timeoutMs: 5000 });
    const admin = await seedUser(api.db, { role: 'admin', email: 'admin@mail.test-only.dev' });
    const r = await request(app).get('/api/capabilities').set({ Authorization: `Bearer ${admin}` }).expect(200);
    const m = r.body.modules as Record<string, { driver: string; status: string; detail?: string }>;
    expect(m.notification).toMatchObject({ driver: 'sns' });
    expect(m.email).toMatchObject({ driver: 'ses', status: 'degraded' });
    expect(m.email!.detail).toMatch(/^沙盒/);
    expect(m.logging).toMatchObject({ driver: 'cloudwatch' });
    expect(m.monitoring).toMatchObject({ driver: 'cloudwatch' });
    for (const id of ['notification', 'logging', 'monitoring']) expect(['ok', 'degraded'], `${id}: ${m[id]!.detail}`).toContain(m[id]!.status);
    // keys 模式（CRED-002）只是 degraded；没有任何模块因“未实现”或配置错误而 error（ec2 反映的是开发机本身，例如磁盘剩余，不在此列）
    expect(Object.entries(m).filter(([k, v]) => k !== 'ec2' && v.status === 'error').map(([k, v]) => `${k}: ${v.detail}`)).toEqual([]);
  });

  it('email：本地注册的验证邮件经 SES 发出（同一份 MIME），路径头 email=ses，outbox_emails 记 transport=ses', async () => {
    const res = await request(app).post('/api/auth/register')
      .send({ email: 'alice@mail.test-only.dev', password: 'Correct-Horse-9', displayName: 'Alice' }).expect(201);
    expect(pathOf(res).email).toMatch(/^ses:/);
    const sent = ses.commandCalls(SendEmailCommand);
    expect(sent.length).toBeGreaterThan(0);
    const input = sent.at(-1)!.args[0].input;
    expect(input.ConfigurationSetName).toBe('cloudalbum-lab-email');
    expect(Buffer.from(input.Content!.Raw!.Data!).toString('utf8')).toContain('X-CloudAlbum-Transport: ses');
    const row = (await api.db('outbox_emails').orderBy('created_at', 'desc').first()) as { transport?: string; provider_message_id?: string };
    expect(row).toMatchObject({ transport: 'ses' });
    expect(row.provider_message_id).toMatch(/^ses-/);
  });

  it('email：反馈队列（SES → SNS → SQS）由 worker 的 consume() 消费，Permanent 退信把地址标记为 bounced', async () => {
    const row = (await api.db('outbox_emails').where({ transport: 'ses' }).orderBy('created_at', 'desc').first()) as { provider_message_id: string };
    sqs.send(FEEDBACK, JSON.stringify({
      eventType: 'Bounce', mail: { messageId: row.provider_message_id, destination: ['alice@mail.test-only.dev'], tags: { category: ['verification'] } },
      bounce: { bounceType: 'Permanent', bouncedRecipients: [{ emailAddress: 'alice@mail.test-only.dev' }] },
    }));
    await waitFor(async () => {
      const r = (await api.db('outbox_emails').where({ provider_message_id: row.provider_message_id }).first('delivery_status')) as { delivery_status?: string };
      return r?.delivery_status === 'bounced';
    }, 10_000);
    const user = (await api.db('users').where({ email: 'alice@mail.test-only.dev' }).first('email_status')) as { email_status: string };
    expect(user.email_status).toBe('bounced');
  });

  it('notification：评论 → 站内信 + 一次 SNS Publish（userId 过滤属性），路径头 notification=sns；收件队列由 worker 消费记 sqs-copy', async () => {
    const owner = await seedUser(api.db, { email: 'owner@mail.test-only.dev', name: 'Owner' });
    const other = await seedUser(api.db, { email: 'other@mail.test-only.dev', name: 'Other' });
    const album = await seedAlbum(api.db, owner, { visibility: 'public' });
    const photoId = randomUUID();
    await insertPhoto(api.db, { id: photoId, ownerId: owner, albumId: album, rawKey: `raw/${owner}/${photoId}.jpg`, filename: 'a.jpg', contentType: 'image/jpeg', sizeBytes: 100, visibility: 'public' });
    await api.db('photos').where({ id: photoId }).update({ status: 'READY', width: 10, height: 10 });

    const before = sns.published.length;
    const res = await request(app).post(`/social/photos/${photoId}/comments`).set({ Authorization: `Bearer ${other}` }).send({ text: '好看！' }).expect(201);
    expect(pathOf(res).notification).toMatch(/^sns:/);
    expect(sns.published.length).toBe(before + 1);
    const pub = sns.published.at(-1)!;
    expect(pub.attributes.userId?.StringValue).toBe(owner);
    expect(pub.attributes.eventType?.StringValue).toBe('comment.created');
    const inbox = (await api.db('notifications').where({ user_id: owner }).first('type')) as { type: string };
    expect(inbox.type).toBe('comment.created');
    // SNS → 收件队列（原始消息传递）→ worker consume()：每个 eventId 记一行 sqs-copy
    await waitFor(async () => {
      const d = (await api.db('notification_deliveries').where({ channel: 'sqs-copy' }).first('event_id')) as { event_id?: string } | undefined;
      return d?.event_id?.startsWith('comment.created:') ? d : null;
    }, 10_000);
    expect(sqs.depth(INBOX)).toEqual({ visible: 0, inFlight: 0 });
  });

  it('logging：应用日志照写本地文件，同时经发送器进入 CloudWatch Logs（/cloudalbum/lab/app 的 {instanceId}/api 流）', async () => {
    api.logger.info('wave1 smoke: logging probe line', { smoke: 'wave1' });
    await api.loggerPort.flush();
    await waitFor(async () => cwl.events('/cloudalbum/lab/app').some((e) => e.message.includes('wave1 smoke: logging probe line')), 10_000);
    const e = cwl.events('/cloudalbum/lab/app').find((x) => x.message.includes('wave1 smoke'))!;
    expect(e.logStreamName).toMatch(/\/api$/);
    expect(JSON.parse(e.message)).toMatchObject({ msg: 'wave1 smoke: logging probe line', smoke: 'wave1' });
  });

  it('monitoring：请求指标与心跳经 PutMetricData 写入 CloudAlbum/App（本地 rollup 照写）', async () => {
    await request(app).get('/api/health/live').expect(200);
    await api.metrics.flush();
    const calls = cw.commandCalls(PutMetricDataCommand);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.args[0].input.Namespace === 'CloudAlbum/App')).toBe(true);
    const names = new Set(calls.flatMap((c) => (c.args[0].input.MetricData ?? []).map((d) => d.MetricName)));
    expect(names.size).toBeGreaterThan(0);
  });
});
