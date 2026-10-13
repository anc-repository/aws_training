// queue=sqs：端口契约（内存 SQS）+ 驱动细节（长轮询、按任务名限并发、心跳、退避、DLQ、部分批删除失败、旁路、探针）
import { ChangeMessageVisibilityCommand, DeleteMessageCommand, SendMessageBatchCommand, SendMessageCommand } from '@aws-sdk/client-sqs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqsQueue, parseConcurrency, parseEnvelope, retryDelaySec } from '../../../src/adapters/queue/sqs.js';
import { createRequestContext, runWithContext } from '../../../src/observability/request-context.js';
import type { QueuePort } from '../../../src/ports/queue.js';
import { ENABLE } from '../../helpers/config.js';
import { describeQueuePortContract } from './contracts/queue.contract.js';
import { FakeSqs } from './fake-sqs.js';
import { awsError, makeDeps, sleep, waitFor } from './helpers.js';

const MAIN = ENABLE.sqs.SQS_QUEUE_URL;
const DLQ = ENABLE.sqs.SQS_DLQ_URL;
const env = { ...ENABLE.iamRole, ...ENABLE.sqs };

let fake: FakeSqs;
beforeEach(() => {
  fake = new FakeSqs();
  fake.createQueue(DLQ);
  fake.createQueue(MAIN, { dlqUrl: DLQ, maxReceiveCount: 3, visibilityTimeoutSec: 120 });
});
afterEach(() => fake.restore());

const newQueue = (extra: Record<string, string> = {}) => new SqsQueue(makeDeps({ ...env, ...extra }), { stopGraceMs: 2000 });

async function runConsumer(q: QueuePort, until: () => boolean, concurrency = 4): Promise<void> {
  const ac = new AbortController();
  const p = q.consume({ concurrency, signal: ac.signal });
  try {
    await waitFor(until);
  } finally {
    ac.abort();
    await p;
  }
}

describeQueuePortContract('sqs（内存 SQS，aws-sdk-client-mock）', {
  async create() {
    return newQueue();
  },
  runConsumer: (q, until) => runConsumer(q, until),
  advanceTime: (ms) => fake.advance(ms),
});

describe('SqsQueue 生产者', () => {
  it('SendMessage：消息体是 JobEnvelope，消息属性 name，DelaySeconds 最多 900；路径头 queue=sqs:queued', async () => {
    const q = newQueue();
    const ctx = createRequestContext();
    const r = await runWithContext(ctx, () => q.enqueue('image.tag', { photoId: 'p1' }, { delaySec: 5000, dedupKey: 'k' }));
    expect(r.mode).toBe('queued');
    const input = fake.mock.commandCalls(SendMessageCommand)[0]!.args[0].input as { MessageBody: string; DelaySeconds: number; MessageAttributes: Record<string, { StringValue: string }> };
    expect(input.DelaySeconds).toBe(900);
    expect(input.MessageAttributes.name!.StringValue).toBe('image.tag');
    expect(parseEnvelope(input.MessageBody)).toMatchObject({ id: r.jobId, name: 'image.tag', payload: { photoId: 'p1' }, dedupKey: 'k', attempt: 1 });
    expect(ctx.path.get('queue')).toBe('sqs:queued');
  });

  it('SendMessage 失败 → 503 QUEUE_UNAVAILABLE（权威端口，不改成当场执行）', async () => {
    fake.mock.on(SendMessageCommand).rejects(awsError('AccessDenied', 403));
    const q = newQueue();
    let ran = false;
    q.bind({ 'email.send': async () => { ran = true; } });
    await expect(q.enqueue('email.send', {})).rejects.toMatchObject({ status: 503, code: 'QUEUE_UNAVAILABLE' });
    expect(ran).toBe(false);
  });

  it('X-Compare-Bypass: queue → 当场执行，不发 SQS；路径头 queue=sqs:bypass-inline', async () => {
    const q = newQueue();
    let ran = 0;
    q.bind({ 'image.process': async () => { ran += 1; } });
    const ctx = createRequestContext({ isAdmin: true });
    ctx.bypass.add('queue');
    const r = await runWithContext(ctx, () => q.enqueue('image.process', { photoId: 'p' }));
    expect(r.mode).toBe('inline');
    expect(ran).toBe(1);
    expect(fake.mock.commandCalls(SendMessageCommand)).toHaveLength(0);
    expect(ctx.path.get('queue')).toBe('sqs:bypass-inline');
  });

  it('enqueueMany 用 SendMessageBatch，每批 ≤10 条', async () => {
    const q = newQueue();
    const r = await q.enqueueMany(Array.from({ length: 12 }, (_, i) => ({ name: 'notify.fanout' as const, payload: { i } })));
    expect(r.jobIds).toHaveLength(12);
    expect(fake.mock.commandCalls(SendMessageBatchCommand)).toHaveLength(2);
    expect(fake.depth(MAIN).visible).toBe(12);
  });
});

describe('SqsQueue 消费者', () => {
  it('长轮询参数：WaitTimeSeconds = SQS_WAIT_TIME_SEC，MaxNumberOfMessages ≤ 10', async () => {
    const q = newQueue({ SQS_WAIT_TIME_SEC: '7' });
    q.bind({ 'email.send': async () => undefined });
    await runConsumer(q, () => fake.receives.length >= 2);
    expect(fake.receives[0]).toMatchObject({ QueueUrl: MAIN, WaitTimeSeconds: 7 });
    expect(fake.receives[0]!.MaxNumberOfMessages).toBeLessThanOrEqual(10);
  });

  it('按任务名限并发（QUEUE_CONCURRENCY）', async () => {
    const q = newQueue({ QUEUE_CONCURRENCY: 'image.process:1,email.send:2' });
    let active = 0;
    let maxActive = 0;
    let done = 0;
    q.bind({ 'image.process': async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await sleep(30);
      active -= 1;
      done += 1;
    } });
    for (let i = 0; i < 4; i += 1) await q.enqueue('image.process', { i });
    await runConsumer(q, () => done >= 4, 8);
    expect(maxActive).toBe(1);
    expect(fake.depth(MAIN)).toEqual({ visible: 0, inFlight: 0 });
  });

  it('坏消息不删除：按接收次数退避，超过 maxReceiveCount 后进入 DLQ；probe 变 degraded；replayDlq 重放', async () => {
    const q = newQueue();
    q.bind({ 'email.send': async () => undefined });
    fake.send(MAIN, '{not json');
    for (let i = 0; i < 4; i += 1) {
      const before = fake.receives.length;
      await runConsumer(q, () => fake.receives.length > before + 1);
      fake.advance(301_000);
    }
    expect(fake.queues.get(DLQ)!.messages).toHaveLength(1);
    const probe = await q.probe();
    expect(probe.status).toBe('degraded');
    expect(probe.detail).toContain('DLQ 1');
    expect(await q.stats()).toMatchObject({ dlqDepth: 1 });
    await q.replayDlq();
    expect(fake.queues.get(DLQ)!.messages).toHaveLength(0);
    expect(fake.queues.get(MAIN)!.messages).toHaveLength(1);
  });

  it('失败的退避时长：10s → 60s → 300s', () => {
    expect([1, 2, 3, 7].map(retryDelaySec)).toEqual([10, 60, 300, 300]);
  });

  it('长任务每隔可见性超时的一半续租（心跳）', async () => {
    fake.queues.get(MAIN)!.visibilityTimeoutSec = 2;
    const q = newQueue();
    let done = false;
    q.bind({ 'analytics.flush': async () => {
      await sleep(1200);
      done = true;
    } });
    await q.enqueue('analytics.flush', {});
    await runConsumer(q, () => done);
    const beats = fake.mock.commandCalls(ChangeMessageVisibilityCommand).map((c) => (c.args[0].input as { VisibilityTimeout: number }).VisibilityTimeout);
    expect(beats).toContain(2);
    expect(fake.depth(MAIN)).toEqual({ visible: 0, inFlight: 0 });
  });

  it('DeleteMessageBatch 部分失败 → 逐条重试删除', async () => {
    const q = newQueue();
    let n = 0;
    q.bind({ 'email.send': async () => { n += 1; } });
    await q.enqueue('email.send', {});
    // 让第一次批量删除失败：拦截 Receive 之后记录 receipt
    const origDepth = fake.queues.get(MAIN)!;
    const watcher = setInterval(() => {
      for (const m of origDepth.messages) if (m.receipt) fake.failDeleteOnce.add(m.receipt);
    }, 1);
    await runConsumer(q, () => n >= 1);
    clearInterval(watcher);
    await waitFor(() => origDepth.messages.length === 0);
    expect(fake.mock.commandCalls(DeleteMessageCommand).length).toBeGreaterThanOrEqual(1);
  });

  it('parseConcurrency：未列出的任务名默认 1，忽略非法值', () => {
    expect(parseConcurrency('image.process:3,email.send:x,bogus:9')).toMatchObject({ 'image.process': 3, 'email.send': 1, 'notify.fanout': 1 });
  });
});

describe('SqsQueue 观测', () => {
  it('stats：可见 + 延迟、处理中、DLQ 深度；drain 超时返回剩余数', async () => {
    const q = newQueue();
    fake.send(MAIN, '{}');
    fake.send(MAIN, '{}', {}, 60);
    fake.send(DLQ, '{}');
    expect(await q.stats()).toEqual({ depth: 2, inFlight: 0, dlqDepth: 1 });
    expect(await q.drain(0)).toEqual({ remaining: 2 });
  });

  it('probe：ok 时 detail 列出深度与 maxReceiveCount；队列不存在 → error', async () => {
    const ok = await newQueue().probe();
    expect(ok.status).toBe('ok');
    expect(ok.detail).toBe('可见 0 · 处理中 0 · DLQ 0 · maxReceiveCount 3');
    fake.queues.delete(DLQ);
    const bad = await newQueue().probe();
    expect(bad.status).toBe('error');
    expect(bad.detail).toContain('队列不存在');
  });

  it('probe：主队列没有 RedrivePolicy → degraded', async () => {
    fake.queues.get(MAIN)!.redrive = undefined;
    const r = await newQueue().probe();
    expect(r.status).toBe('degraded');
    expect(r.detail).toContain('RedrivePolicy');
  });
});
