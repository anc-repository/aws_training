// backend/src/adapters/notification/sqs-poll.ts —— 模块自带 SQS 队列的长轮询消费（wave1-sns-ses）
//
// notification 的收件队列（SNS → SQS 扇出，原始消息传递）与 email 的反馈队列（SES 事件 → SNS → SQS）共用这段循环：
//   - ReceiveMessage 长轮询（WaitTimeSeconds 默认 20，每次最多 10 条）；
//   - handle() 返回 true → 删除；返回 false 或抛错 → 不删除，可见性超时后重投，超过 maxReceiveCount 由 SQS 移入 DLQ；
//   - 接收失败按 0.5 → 1 → 2 … 秒退避（上限 20 秒），不会因为一次网络抖动让 worker 退出；
//   - signal 终止时立即返回（ReceiveMessage 带 abortSignal）。
// 两个队列都是“附加观察通道”，处理很轻（写几行数据库），所以逐条串行处理，不需要 QueuePort 那样的限并发与心跳。
import type { Message, SQSClient } from '@aws-sdk/client-sqs';
import type { Logger } from '../../ports/logger.js';
import { describeAwsError, loadAwsPackage } from '../aws/clients.js';

export interface PollStats {
  received: number;
  handled: number;
  failed: number;
  lastReceiveAt?: string;
  lastError?: string;
}

export interface PollOptions {
  /** 日志里的队列名（notification-inbox、email-feedback） */
  name: string;
  queueUrl: string;
  client: () => Promise<SQSClient>;
  /** 处理一条消息：true = 删除；false = 留在队列里重试 */
  handle: (m: Message) => Promise<boolean>;
  signal: AbortSignal;
  waitTimeSec?: number;
  maxMessages?: number;
  maxBackoffMs?: number;
  logger?: Pick<Logger, 'warn'>;
  stats?: PollStats;
}

export function newPollStats(): PollStats {
  return { received: 0, handled: 0, failed: 0 };
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(t);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const t = setTimeout(done, ms);
    t.unref?.();
    signal?.addEventListener('abort', done, { once: true });
  });
}

/** 阻塞直到 signal 终止 */
export async function pollQueue(o: PollOptions): Promise<void> {
  const { ReceiveMessageCommand, DeleteMessageCommand } = await loadAwsPackage('@aws-sdk/client-sqs', () => import('@aws-sdk/client-sqs'));
  const stats = o.stats ?? newPollStats();
  const maxBackoff = o.maxBackoffMs ?? 20_000;
  let backoff = 500;
  while (!o.signal.aborted) {
    let messages: Message[] = [];
    try {
      const sqs = await o.client();
      const r = await sqs.send(new ReceiveMessageCommand({
        QueueUrl: o.queueUrl,
        MaxNumberOfMessages: Math.max(1, Math.min(10, o.maxMessages ?? 10)),
        WaitTimeSeconds: o.waitTimeSec ?? 20,
        MessageSystemAttributeNames: ['ApproximateReceiveCount', 'SentTimestamp'],
        MessageAttributeNames: ['All'],
      }), { abortSignal: o.signal });
      messages = r.Messages ?? [];
      backoff = 500;
    } catch (e) {
      if (o.signal.aborted) break;
      stats.lastError = describeAwsError(e);
      o.logger?.warn(`${o.name}.receive_failed`, { error: stats.lastError });
      await sleep(backoff, o.signal);
      backoff = Math.min(maxBackoff, backoff * 2);
      continue;
    }
    if (messages.length) stats.lastReceiveAt = new Date().toISOString();
    for (const m of messages) {
      stats.received += 1;
      let ok = false;
      try {
        ok = await o.handle(m);
      } catch (e) {
        stats.lastError = (e as Error)?.message ?? String(e);
        o.logger?.warn(`${o.name}.handle_failed`, { messageId: m.MessageId, error: stats.lastError });
      }
      if (!ok) {
        stats.failed += 1;
        continue;
      }
      stats.handled += 1;
      if (!m.ReceiptHandle) continue;
      try {
        const sqs = await o.client();
        await sqs.send(new DeleteMessageCommand({ QueueUrl: o.queueUrl, ReceiptHandle: m.ReceiptHandle }));
      } catch (e) {
        // 删除失败：消息会在可见性超时后再次出现；handle() 按 eventId / SES messageId 幂等
        o.logger?.warn(`${o.name}.delete_failed`, { messageId: m.MessageId, error: describeAwsError(e) });
      }
    }
  }
}

/** SQS 队列 ARN → URL（arn:aws:sqs:<region>:<acct>:<name> → https://sqs.<region>.amazonaws.com/<acct>/<name>） */
export function queueUrlFromArn(arn: string, endpoint?: string): string | undefined {
  const m = /^arn:aws[a-z-]*:sqs:([a-z0-9-]+):(\d{12}):(.+)$/.exec(arn);
  if (!m) return undefined;
  const base = endpoint ? endpoint.replace(/\/+$/, '') : `https://sqs.${m[1]}.amazonaws.com`;
  return `${base}/${m[2]}/${m[3]}`;
}

/** 消息体：原始消息传递时就是发布的内容；没开原始消息传递时是 SNS 信封 {Type: 'Notification', Message} */
export function unwrapSnsEnvelope(body: string | undefined): unknown {
  if (!body) return undefined;
  let v: unknown;
  try {
    v = JSON.parse(body);
  } catch {
    return undefined;
  }
  const env = v as { Type?: unknown; Message?: unknown; TopicArn?: unknown };
  if (env && typeof env === 'object' && env.Type === 'Notification' && typeof env.Message === 'string' && typeof env.TopicArn === 'string') {
    try {
      return JSON.parse(env.Message);
    } catch {
      return env.Message;
    }
  }
  return v;
}
