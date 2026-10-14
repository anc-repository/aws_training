// 内存版 SNS（notification=sns 的本地替身，wave1-sns-ses）：主题、订阅（email / sqs）、确认状态、按消息属性的订阅过滤策略
// （含 $or）、MessageStructure=json 的按协议取文本、SQS 订阅的原始消息传递（投进 FakeSqs 的队列）。不访问网络。
// 只实现 SnsNotifier 用到的操作；过滤只支持“属性值精确匹配字符串列表”，足以验证 userId / audience 策略。
import { randomUUID } from 'node:crypto';
import {
  GetSubscriptionAttributesCommand, GetTopicAttributesCommand, ListSubscriptionsByTopicCommand, PublishCommand, SetSubscriptionAttributesCommand,
  SNSClient, SubscribeCommand, UnsubscribeCommand,
} from '@aws-sdk/client-sns';
import { mockClient, type AwsClientStub } from 'aws-sdk-client-mock';
import type { FakeSqs } from './fake-sqs.js';
import { awsError } from './helpers.js';

export interface FakeSubscription {
  arn: string;
  topicArn: string;
  protocol: 'email' | 'sqs';
  endpoint: string;
  pending: boolean;
  filterPolicy?: Record<string, unknown>;
  raw: boolean;
}

export interface FakeDelivery { subscriptionArn: string; protocol: string; endpoint: string; body: string; subject?: string }

type Attrs = Record<string, { DataType: string; StringValue?: string }>;

/** 订阅过滤策略（MessageAttributes 范围）：每个键的值必须在列表中；$or 任一分支满足 */
export function matchesPolicy(policy: Record<string, unknown> | undefined, attrs: Attrs): boolean {
  if (!policy) return true;
  for (const [k, v] of Object.entries(policy)) {
    if (k === '$or') {
      if (!(v as Array<Record<string, unknown>>).some((branch) => matchesPolicy(branch, attrs))) return false;
      continue;
    }
    const actual = attrs[k]?.StringValue;
    if (actual === undefined || !(v as unknown[]).includes(actual)) return false;
  }
  return true;
}

export class FakeSns {
  readonly mock: AwsClientStub<SNSClient>;
  readonly topics = new Map<string, { attributes: Record<string, string> }>();
  readonly subscriptions: FakeSubscription[] = [];
  readonly deliveries: FakeDelivery[] = [];
  readonly published: Array<{ messageId: string; attributes: Attrs; message: string; subject?: string }> = [];
  filteredOut = 0;

  constructor(private readonly sqs?: FakeSqs) {
    this.mock = mockClient(SNSClient);
    this.install();
  }

  createTopic(arn: string, attributes: Record<string, string> = {}): void {
    this.topics.set(arn, { attributes: { TopicArn: arn, DisplayName: 'CloudAlbum', ...attributes } });
  }

  addSubscription(s: Omit<FakeSubscription, 'arn' | 'raw'> & { raw?: boolean }): FakeSubscription {
    const sub: FakeSubscription = { ...s, raw: s.raw ?? false, arn: `${s.topicArn}:${randomUUID()}` };
    this.subscriptions.push(sub);
    return sub;
  }

  /** 收件人点击了确认链接 */
  confirm(endpoint: string): void {
    for (const s of this.subscriptions) if (s.endpoint === endpoint) s.pending = false;
  }

  /** 收件人点击了退订链接（订阅消失） */
  remove(endpoint: string): void {
    for (let i = this.subscriptions.length - 1; i >= 0; i -= 1) if (this.subscriptions[i]!.endpoint === endpoint) this.subscriptions.splice(i, 1);
  }

  private topic(arn: string) {
    const t = this.topics.get(arn);
    if (!t) throw awsError('NotFoundException', 404, 'Topic does not exist');
    return t;
  }

  private sub(arn: string): FakeSubscription {
    const s = this.subscriptions.find((x) => x.arn === arn);
    if (!s) throw awsError('NotFoundException', 404, 'Subscription does not exist');
    return s;
  }

  private install(): void {
    const m = this.mock as unknown as { on: (cmd: unknown) => { callsFake: (fn: (input: never) => unknown) => void } };
    m.on(PublishCommand).callsFake((i: { TopicArn: string; Message: string; MessageStructure?: string; MessageAttributes?: Attrs; Subject?: string }) => {
      this.topic(i.TopicArn);
      const messageId = randomUUID();
      const attrs = i.MessageAttributes ?? {};
      this.published.push({ messageId, attributes: attrs, message: i.Message, ...(i.Subject ? { subject: i.Subject } : {}) });
      const per = i.MessageStructure === 'json' ? (JSON.parse(i.Message) as Record<string, string>) : undefined;
      for (const s of this.subscriptions.filter((x) => x.topicArn === i.TopicArn && !x.pending)) {
        if (!matchesPolicy(s.filterPolicy, attrs)) {
          this.filteredOut += 1;
          continue;
        }
        const body = per ? (per[s.protocol] ?? per.default ?? '') : i.Message;
        this.deliveries.push({ subscriptionArn: s.arn, protocol: s.protocol, endpoint: s.endpoint, body, ...(i.Subject ? { subject: i.Subject } : {}) });
        if (s.protocol === 'sqs' && this.sqs) {
          const q = [...this.sqs.queues.values()].find((x) => x.arn === s.endpoint);
          if (q) {
            const payload = s.raw ? body : JSON.stringify({ Type: 'Notification', MessageId: messageId, TopicArn: i.TopicArn, Message: body });
            this.sqs.send(q.url, payload, s.raw ? attrs : {});
          }
        }
      }
      return { MessageId: messageId };
    });
    m.on(SubscribeCommand).callsFake((i: { TopicArn: string; Protocol: 'email' | 'sqs'; Endpoint: string; Attributes?: Record<string, string>; ReturnSubscriptionArn?: boolean }) => {
      this.topic(i.TopicArn);
      const policy = i.Attributes?.FilterPolicy ? (JSON.parse(i.Attributes.FilterPolicy) as Record<string, unknown>) : undefined;
      const existing = this.subscriptions.find((s) => s.topicArn === i.TopicArn && s.protocol === i.Protocol && s.endpoint === i.Endpoint);
      if (existing) {
        if (JSON.stringify(existing.filterPolicy) !== JSON.stringify(policy)) {
          throw awsError('InvalidParameterException', 400, 'Invalid parameter: Attributes Reason: Subscription already exists with different attributes');
        }
        return { SubscriptionArn: existing.arn };
      }
      const sub = this.addSubscription({ topicArn: i.TopicArn, protocol: i.Protocol, endpoint: i.Endpoint, pending: i.Protocol === 'email', ...(policy ? { filterPolicy: policy } : {}) });
      return { SubscriptionArn: i.ReturnSubscriptionArn || !sub.pending ? sub.arn : 'pending confirmation' };
    });
    m.on(GetSubscriptionAttributesCommand).callsFake((i: { SubscriptionArn: string }) => {
      const s = this.sub(i.SubscriptionArn);
      return {
        Attributes: {
          SubscriptionArn: s.arn, TopicArn: s.topicArn, Protocol: s.protocol, Endpoint: s.endpoint, PendingConfirmation: String(s.pending),
          ...(s.filterPolicy ? { FilterPolicy: JSON.stringify(s.filterPolicy), FilterPolicyScope: 'MessageAttributes' } : {}),
          RawMessageDelivery: String(s.raw),
        },
      };
    });
    m.on(SetSubscriptionAttributesCommand).callsFake((i: { SubscriptionArn: string; AttributeName: string; AttributeValue: string }) => {
      const s = this.sub(i.SubscriptionArn);
      if (i.AttributeName === 'FilterPolicy') s.filterPolicy = JSON.parse(i.AttributeValue) as Record<string, unknown>;
      return {};
    });
    m.on(UnsubscribeCommand).callsFake((i: { SubscriptionArn: string }) => {
      const idx = this.subscriptions.findIndex((s) => s.arn === i.SubscriptionArn);
      if (idx < 0) throw awsError('NotFoundException', 404, 'Subscription does not exist');
      this.subscriptions.splice(idx, 1);
      return {};
    });
    m.on(ListSubscriptionsByTopicCommand).callsFake((i: { TopicArn: string }) => {
      this.topic(i.TopicArn);
      return {
        Subscriptions: this.subscriptions.filter((s) => s.topicArn === i.TopicArn).map((s) => ({
          SubscriptionArn: s.pending ? 'PendingConfirmation' : s.arn, Protocol: s.protocol, Endpoint: s.endpoint, TopicArn: s.topicArn, Owner: '123456789012',
        })),
      };
    });
    m.on(GetTopicAttributesCommand).callsFake((i: { TopicArn: string }) => {
      const t = this.topic(i.TopicArn);
      const subs = this.subscriptions.filter((s) => s.topicArn === i.TopicArn);
      return {
        Attributes: {
          ...t.attributes,
          SubscriptionsConfirmed: String(subs.filter((s) => !s.pending).length),
          SubscriptionsPending: String(subs.filter((s) => s.pending).length),
          SubscriptionsDeleted: '0',
        },
      };
    });
  }

  restore(): void {
    this.mock.restore();
  }
}
