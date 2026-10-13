// 内存版 SQS：可见性超时、接收次数、maxReceiveCount → DLQ、StartMessageMoveTask（端口契约测试用，不访问网络）。
// 时间由测试控制（advance()），长轮询在没有可见消息时短暂等待后返回空。
import { randomUUID } from 'node:crypto';
import {
  ChangeMessageVisibilityCommand, DeleteMessageBatchCommand, DeleteMessageCommand, GetQueueAttributesCommand,
  ReceiveMessageCommand, SendMessageBatchCommand, SendMessageCommand, SQSClient, StartMessageMoveTaskCommand,
} from '@aws-sdk/client-sqs';
import { mockClient, type AwsStub } from 'aws-sdk-client-mock';
import { awsError } from './helpers.js';

interface FakeMessage {
  id: string;
  body: string;
  attributes: Record<string, { DataType: string; StringValue?: string }>;
  receiveCount: number;
  visibleAt: number;
  receipt?: string;
  sentAt: number;
}

interface FakeQueue { url: string; arn: string; messages: FakeMessage[]; visibilityTimeoutSec: number; redrive?: { dlqUrl: string; maxReceiveCount: number } }

export class FakeSqs {
  readonly queues = new Map<string, FakeQueue>();
  readonly mock: AwsStub<object, object, object>;
  private offsetMs = 0;
  /** 每次 Receive 的调用记录（用于断言长轮询参数） */
  readonly receives: Array<{ QueueUrl: string; MaxNumberOfMessages?: number; WaitTimeSeconds?: number }> = [];
  /** DeleteMessageBatch 时让这些 receipt 失败一次（部分失败） */
  readonly failDeleteOnce = new Set<string>();

  constructor() {
    this.mock = mockClient(SQSClient) as unknown as AwsStub<object, object, object>;
    this.install();
  }

  now(): number {
    return Date.now() + this.offsetMs;
  }

  advance(ms: number): void {
    this.offsetMs += ms;
  }

  createQueue(url: string, opts: { visibilityTimeoutSec?: number; dlqUrl?: string; maxReceiveCount?: number } = {}): void {
    const name = url.split('/').pop()!;
    this.queues.set(url, {
      url, arn: `arn:aws:sqs:ap-northeast-1:123456789012:${name}`, messages: [], visibilityTimeoutSec: opts.visibilityTimeoutSec ?? 30,
      ...(opts.dlqUrl ? { redrive: { dlqUrl: opts.dlqUrl, maxReceiveCount: opts.maxReceiveCount ?? 3 } } : {}),
    });
  }

  private q(url: string): FakeQueue {
    const q = this.queues.get(url);
    if (!q) throw awsError('AWS.SimpleQueueService.NonExistentQueue', 400, `queue ${url} does not exist`);
    return q;
  }

  send(url: string, body: string, attributes: FakeMessage['attributes'] = {}, delaySec = 0): string {
    const id = randomUUID();
    this.q(url).messages.push({ id, body, attributes, receiveCount: 0, visibleAt: this.now() + delaySec * 1000, sentAt: this.now() });
    return id;
  }

  depth(url: string): { visible: number; inFlight: number } {
    const now = this.now();
    const msgs = this.q(url).messages;
    return { visible: msgs.filter((m) => m.visibleAt <= now && !m.receipt).length + msgs.filter((m) => m.receipt && m.visibleAt <= now).length, inFlight: msgs.filter((m) => m.receipt && m.visibleAt > now).length };
  }

  private install(): void {
    const m = this.mock as unknown as { on: (cmd: unknown) => { callsFake: (fn: (input: never) => unknown) => void } };
    m.on(SendMessageCommand).callsFake((i: { QueueUrl: string; MessageBody: string; MessageAttributes?: FakeMessage['attributes']; DelaySeconds?: number }) => ({
      MessageId: this.send(i.QueueUrl, i.MessageBody, i.MessageAttributes ?? {}, i.DelaySeconds ?? 0),
    }));
    m.on(SendMessageBatchCommand).callsFake((i: { QueueUrl: string; Entries: Array<{ Id: string; MessageBody: string; MessageAttributes?: FakeMessage['attributes']; DelaySeconds?: number }> }) => ({
      Successful: i.Entries.map((e) => ({ Id: e.Id, MessageId: this.send(i.QueueUrl, e.MessageBody, e.MessageAttributes ?? {}, e.DelaySeconds ?? 0) })),
      Failed: [],
    }));
    m.on(ReceiveMessageCommand).callsFake(async (i: { QueueUrl: string; MaxNumberOfMessages?: number; WaitTimeSeconds?: number }) => {
      this.receives.push(i);
      const q = this.q(i.QueueUrl);
      const out = [];
      const now = this.now();
      for (const msg of [...q.messages]) {
        if (out.length >= (i.MaxNumberOfMessages ?? 1)) break;
        if (msg.visibleAt > now) continue;
        if (q.redrive && msg.receiveCount >= q.redrive.maxReceiveCount) {
          // 超过 maxReceiveCount：SQS 把消息移入 DLQ
          q.messages.splice(q.messages.indexOf(msg), 1);
          this.q(q.redrive.dlqUrl).messages.push({ ...msg, receipt: undefined as never, receiveCount: 0, visibleAt: now });
          continue;
        }
        msg.receiveCount += 1;
        msg.receipt = randomUUID();
        msg.visibleAt = now + q.visibilityTimeoutSec * 1000;
        out.push({
          MessageId: msg.id, ReceiptHandle: msg.receipt, Body: msg.body, MessageAttributes: msg.attributes,
          Attributes: { ApproximateReceiveCount: String(msg.receiveCount), SentTimestamp: String(msg.sentAt) },
        });
      }
      if (!out.length) await new Promise((r) => setTimeout(r, 5));
      return { Messages: out };
    });
    const remove = (url: string, receipt: string): boolean => {
      const q = this.q(url);
      const idx = q.messages.findIndex((x) => x.receipt === receipt);
      if (idx < 0) return false;
      q.messages.splice(idx, 1);
      return true;
    };
    m.on(DeleteMessageCommand).callsFake((i: { QueueUrl: string; ReceiptHandle: string }) => {
      remove(i.QueueUrl, i.ReceiptHandle);
      return {};
    });
    m.on(DeleteMessageBatchCommand).callsFake((i: { QueueUrl: string; Entries: Array<{ Id: string; ReceiptHandle: string }> }) => {
      const Successful = [];
      const Failed = [];
      for (const e of i.Entries) {
        if (this.failDeleteOnce.delete(e.ReceiptHandle)) {
          Failed.push({ Id: e.Id, Code: 'InternalError', SenderFault: false });
          continue;
        }
        remove(i.QueueUrl, e.ReceiptHandle);
        Successful.push({ Id: e.Id });
      }
      return { Successful, Failed };
    });
    m.on(ChangeMessageVisibilityCommand).callsFake((i: { QueueUrl: string; ReceiptHandle: string; VisibilityTimeout: number }) => {
      const msg = this.q(i.QueueUrl).messages.find((x) => x.receipt === i.ReceiptHandle);
      if (msg) msg.visibleAt = this.now() + i.VisibilityTimeout * 1000;
      return {};
    });
    m.on(GetQueueAttributesCommand).callsFake((i: { QueueUrl: string }) => {
      const q = this.q(i.QueueUrl);
      const now = this.now();
      const visible = q.messages.filter((x) => x.visibleAt <= now && (!x.receipt || x.visibleAt <= now)).length;
      const notVisible = q.messages.filter((x) => x.receipt && x.visibleAt > now).length;
      const delayed = q.messages.filter((x) => !x.receipt && x.visibleAt > now).length;
      return {
        Attributes: {
          QueueArn: q.arn, VisibilityTimeout: String(q.visibilityTimeoutSec),
          ApproximateNumberOfMessages: String(visible), ApproximateNumberOfMessagesNotVisible: String(notVisible),
          ApproximateNumberOfMessagesDelayed: String(delayed), MessageRetentionPeriod: '1209600',
          ...(q.redrive ? { RedrivePolicy: JSON.stringify({ deadLetterTargetArn: this.q(q.redrive.dlqUrl).arn, maxReceiveCount: q.redrive.maxReceiveCount }) } : {}),
        },
      };
    });
    m.on(StartMessageMoveTaskCommand).callsFake((i: { SourceArn: string; DestinationArn: string }) => {
      const src = [...this.queues.values()].find((q) => q.arn === i.SourceArn)!;
      const dst = [...this.queues.values()].find((q) => q.arn === i.DestinationArn)!;
      for (const msg of src.messages.splice(0)) dst.messages.push({ ...msg, receiveCount: 0, visibleAt: this.now(), receipt: undefined as never });
      return { TaskHandle: 'task-1' };
    });
  }

  restore(): void {
    this.mock.restore();
  }
}
