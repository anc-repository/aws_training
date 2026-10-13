// backend/src/adapters/queue/sqs.ts —— QueuePort 的 `sqs` 驱动（Amazon SQS，04#queue 第 2 节）
//
// 生产者：SendMessage（消息体 = JobEnvelope 的 JSON；消息属性 name；delaySec → DelaySeconds，最多 900 秒）；
//         enqueueMany() 用 SendMessageBatch（每批 ≤10 条）。
// 消费者（cloudalbum-worker）：QUEUE_SQS_POLLERS 个长轮询循环（WaitTimeSeconds=SQS_WAIT_TIME_SEC，MaxNumberOfMessages ≤10）；
//   - 按任务名限并发（QUEUE_CONCURRENCY），总在途不超过 consume({concurrency})；
//   - 成功：DeleteMessageBatch（部分失败的条目逐条重试删除）；
//   - 失败：不删除，ChangeMessageVisibility 按接收次数退避（10s、60s、300s）；接收次数超过 maxReceiveCount 后 SQS 自动移入 DLQ；
//   - 长任务：每隔可见性超时的一半续租一次（心跳）；
//   - signal 终止：停止接收，等待在途任务完成（最多 stopGraceMs），没完成的消息在可见性超时后自动重新出现。
// 语义：{ durable: true, consumer: 'worker', delivery: 'at-least-once' }——handler 必须幂等（jobs/index.ts 的 idempotent()）。
// 运行时旁路（总纲 8.3 的 queue 键）：管理员请求带 X-Compare-Bypass: queue 时 enqueue() 当场执行，路径头 queue=sqs:bypass-inline。
// 权威端口：SendMessage 失败直接抛出（HTTP 层 503），不偷偷改成当场执行。
import { randomUUID } from 'node:crypto';
import type { Message, QueueAttributeName, SQSClient } from '@aws-sdk/client-sqs';
import { HttpError } from '../../errors.js';
import { isBypassed, markPath } from '../../observability/request-context.js';
import type { AdapterMeta, ProbeResult } from '../../ports/common.js';
import type { JobEnvelope, JobHandler, JobName, QueuePort } from '../../ports/queue.js';
import { describeAwsError, isAwsAccessDenied, isAwsNotFound, loadAwsPackage } from '../aws/clients.js';
import type { AdapterDeps } from '../types.js';

type SqsConfig = Extract<AdapterDeps['cfg']['queue'], { QUEUE_DRIVER: 'sqs' }>;
type SqsSdk = typeof import('@aws-sdk/client-sqs');

export const JOB_NAMES: readonly JobName[] = ['image.process', 'image.tag', 'notify.fanout', 'email.send', 'analytics.flush'];

/** 失败后的可见性退避（按 ApproximateReceiveCount：第 1 次失败 10 秒、第 2 次 60 秒、之后 300 秒） */
export function retryDelaySec(receiveCount: number): number {
  if (receiveCount <= 1) return 10;
  if (receiveCount === 2) return 60;
  return 300;
}

/** `image.process:1,image.tag:2,…` → 每个任务名的并发上限（未列出的为 1） */
export function parseConcurrency(spec: string): Record<JobName, number> {
  const out = Object.fromEntries(JOB_NAMES.map((n) => [n, 1])) as Record<JobName, number>;
  for (const part of spec.split(',')) {
    const [name, n] = part.split(':').map((s) => s.trim());
    if (name && (JOB_NAMES as readonly string[]).includes(name)) {
      const v = Number(n);
      if (Number.isInteger(v) && v >= 1) out[name as JobName] = v;
    }
  }
  return out;
}

function isJobName(x: unknown): x is JobName {
  return typeof x === 'string' && (JOB_NAMES as readonly string[]).includes(x);
}

export function parseEnvelope(body: string | undefined): JobEnvelope | null {
  if (!body) return null;
  try {
    const v = JSON.parse(body) as Partial<JobEnvelope>;
    if (!v || typeof v.id !== 'string' || !isJobName(v.name) || typeof v.enqueuedAt !== 'string') return null;
    return {
      id: v.id, name: v.name, payload: v.payload, attempt: typeof v.attempt === 'number' ? v.attempt : 1, enqueuedAt: v.enqueuedAt,
      ...(typeof v.traceparent === 'string' ? { traceparent: v.traceparent } : {}),
      ...(typeof v.dedupKey === 'string' ? { dedupKey: v.dedupKey } : {}),
    };
  } catch {
    return null;
  }
}

/** 简单的计数信号量（按任务名限并发） */
class Gate {
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  constructor(private readonly limit: number) {}
  get size(): number {
    return this.active;
  }
  async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active += 1;
  }
  release(): void {
    this.active -= 1;
    this.waiters.shift()?.();
  }
}

export interface SqsQueueOptions {
  /** 停机时等待在途任务的上限（默认 25 秒，小于 systemd TimeoutStopSec） */
  stopGraceMs?: number;
  /** 接收失败后的退避上限（默认 20 秒） */
  maxPollBackoffMs?: number;
}

export class SqsQueue implements QueuePort {
  readonly meta: AdapterMeta = { module: 'queue', driver: 'sqs', awsService: 'Amazon SQS', authoritative: true };
  readonly semantics: QueuePort['semantics'] = { durable: true, consumer: 'worker', delivery: 'at-least-once' };

  private readonly qcfg: SqsConfig;
  private readonly handlers: Partial<Record<JobName, JobHandler>> = {};
  private readonly gates: Record<JobName, Gate>;
  private sdkPromise?: Promise<SqsSdk>;
  private inFlight = 0;
  private readonly slotWaiters: Array<() => void> = [];
  private visibilityTimeoutSec = 120;
  private internalAbort?: AbortController;
  private readonly pendingDeletes: Array<{ handle: string; resolve: () => void }> = [];
  private deleteTimer?: NodeJS.Timeout;
  private readonly opts: Required<SqsQueueOptions>;
  private queueArns: { main?: string; dlq?: string } = {};
  private stats5m = { processed: 0, failed: 0, since: Date.now() };

  constructor(protected readonly deps: AdapterDeps, opts: SqsQueueOptions = {}) {
    const q = deps.cfg.queue;
    if (q.QUEUE_DRIVER !== 'sqs') throw new Error(`SqsQueue 需要 QUEUE_DRIVER=sqs（当前 ${q.QUEUE_DRIVER}）`);
    this.qcfg = q;
    const limits = parseConcurrency(q.QUEUE_CONCURRENCY);
    this.gates = Object.fromEntries(JOB_NAMES.map((n) => [n, new Gate(limits[n])])) as Record<JobName, Gate>;
    this.opts = { stopGraceMs: opts.stopGraceMs ?? 25_000, maxPollBackoffMs: opts.maxPollBackoffMs ?? 20_000 };
  }

  private client(): Promise<SQSClient> {
    return this.deps.aws.sqs();
  }

  private sdk(): Promise<SqsSdk> {
    this.sdkPromise ??= loadAwsPackage('@aws-sdk/client-sqs', () => import('@aws-sdk/client-sqs'));
    return this.sdkPromise;
  }

  bind(handlers: Partial<Record<JobName, JobHandler>>): void {
    Object.assign(this.handlers, handlers);
  }

  // ------------------------------------------------------------------------------------------
  // 生产者
  // ------------------------------------------------------------------------------------------
  private envelope<P>(name: JobName, payload: P, opts?: { dedupKey?: string }): JobEnvelope<P> {
    return {
      id: randomUUID(), name, payload, attempt: 1, enqueuedAt: new Date().toISOString(),
      ...(opts?.dedupKey ? { dedupKey: opts.dedupKey } : {}),
    };
  }

  async enqueue<P>(name: JobName, payload: P, opts?: { delaySec?: number; dedupKey?: string }): Promise<{ jobId: string; mode: 'inline' | 'queued' }> {
    const env = this.envelope(name, payload, opts);
    if (isBypassed('queue')) {
      const handler = this.handlers[name];
      if (!handler) throw new HttpError(500, 'QUEUE_HANDLER_MISSING', `没有为 ${name} 绑定 handler（bypass 需要在本进程执行）`);
      await handler(env);
      markPath('queue', 'sqs:bypass-inline');
      return { jobId: env.id, mode: 'inline' };
    }
    const { SendMessageCommand } = await this.sdk();
    try {
      const sqs = await this.client();
      await sqs.send(new SendMessageCommand({
        QueueUrl: this.qcfg.SQS_QUEUE_URL,
        MessageBody: JSON.stringify(env),
        MessageAttributes: { name: { DataType: 'String', StringValue: name } },
        ...(opts?.delaySec ? { DelaySeconds: Math.max(0, Math.min(900, Math.floor(opts.delaySec))) } : {}),
      }));
    } catch (e) {
      throw new HttpError(503, 'QUEUE_UNAVAILABLE', `SQS SendMessage 失败：${describeAwsError(e)}`, { module: 'queue', driver: 'sqs' });
    }
    markPath('queue', 'sqs:queued');
    return { jobId: env.id, mode: 'queued' };
  }

  /** 一次产生多条任务（例如通知扇出）：SendMessageBatch，每批最多 10 条；有失败条目时抛出 */
  async enqueueMany<P>(jobs: Array<{ name: JobName; payload: P; dedupKey?: string; delaySec?: number }>): Promise<{ jobIds: string[] }> {
    const { SendMessageBatchCommand } = await this.sdk();
    const envs = jobs.map((j) => ({ env: this.envelope(j.name, j.payload, j), delaySec: j.delaySec }));
    try {
      const sqs = await this.client();
      for (let i = 0; i < envs.length; i += 10) {
        const chunk = envs.slice(i, i + 10);
        const r = await sqs.send(new SendMessageBatchCommand({
          QueueUrl: this.qcfg.SQS_QUEUE_URL,
          Entries: chunk.map(({ env, delaySec }, idx) => ({
            Id: String(idx), MessageBody: JSON.stringify(env),
            MessageAttributes: { name: { DataType: 'String', StringValue: env.name } },
            ...(delaySec ? { DelaySeconds: Math.max(0, Math.min(900, Math.floor(delaySec))) } : {}),
          })),
        }));
        if (r.Failed?.length) throw new Error(`SendMessageBatch 有 ${r.Failed.length} 条失败：${r.Failed.map((f) => f.Code).join(', ')}`);
      }
    } catch (e) {
      throw new HttpError(503, 'QUEUE_UNAVAILABLE', `SQS SendMessageBatch 失败：${describeAwsError(e)}`, { module: 'queue', driver: 'sqs' });
    }
    markPath('queue', 'sqs:queued');
    return { jobIds: envs.map((e) => e.env.id) };
  }

  // ------------------------------------------------------------------------------------------
  // 消费者
  // ------------------------------------------------------------------------------------------
  async consume(opts: { concurrency: number; signal: AbortSignal }): Promise<void> {
    const concurrency = Math.max(1, opts.concurrency);
    this.internalAbort = new AbortController();
    const signal = AbortSignal.any([opts.signal, this.internalAbort.signal]);
    await this.loadQueueAttributes().catch(() => undefined);
    const pollers = Array.from({ length: Math.max(1, this.qcfg.QUEUE_SQS_POLLERS) }, (_, i) => this.pollLoop(i, concurrency, signal));
    await Promise.all(pollers);
    // 停止接收：等待在途任务（不超过 stopGraceMs），然后把待删除的批次刷掉
    const deadline = Date.now() + this.opts.stopGraceMs;
    while (this.inFlight > 0 && Date.now() < deadline) await sleep(50);
    await this.flushDeletes();
  }

  private async waitForSlot(concurrency: number, signal: AbortSignal): Promise<number> {
    while (this.inFlight >= concurrency && !signal.aborted) {
      await new Promise<void>((resolve) => {
        const done = () => {
          signal.removeEventListener('abort', done);
          resolve();
        };
        this.slotWaiters.push(done);
        signal.addEventListener('abort', done, { once: true });
      });
    }
    return concurrency - this.inFlight;
  }

  private async pollLoop(index: number, concurrency: number, signal: AbortSignal): Promise<void> {
    const { ReceiveMessageCommand } = await this.sdk();
    let backoff = 500;
    while (!signal.aborted) {
      const free = await this.waitForSlot(concurrency, signal);
      if (signal.aborted) break;
      let messages: Message[] = [];
      try {
        const sqs = await this.client();
        const r = await sqs.send(new ReceiveMessageCommand({
          QueueUrl: this.qcfg.SQS_QUEUE_URL,
          MaxNumberOfMessages: Math.max(1, Math.min(10, free)),
          WaitTimeSeconds: this.qcfg.SQS_WAIT_TIME_SEC,
          MessageSystemAttributeNames: ['ApproximateReceiveCount', 'SentTimestamp'],
          MessageAttributeNames: ['All'],
        }), { abortSignal: signal });
        messages = r.Messages ?? [];
        backoff = 500;
      } catch (e) {
        if (signal.aborted) break;
        this.deps.logger?.warn('queue.sqs.receive_failed', { poller: index, error: describeAwsError(e) });
        await sleep(backoff, signal);
        backoff = Math.min(this.opts.maxPollBackoffMs, backoff * 2);
        continue;
      }
      for (const m of messages) {
        this.inFlight += 1;
        void this.dispatch(m).finally(() => {
          this.inFlight -= 1;
          this.slotWaiters.shift()?.();
        });
      }
    }
  }

  /** 处理一条消息：解析 → 按任务名限并发 → 心跳续租 → handler → 删除或退避 */
  async dispatch(m: Message): Promise<'deleted' | 'retry' | 'poison'> {
    const receiveCount = Number(m.Attributes?.ApproximateReceiveCount ?? '1');
    const env = parseEnvelope(m.Body);
    const handler = env ? this.handlers[env.name] : undefined;
    if (!env || !handler || !m.ReceiptHandle) {
      // 坏消息 / 未绑定的任务名：不删除，按接收次数退避，超过 maxReceiveCount 后由 SQS 移入 DLQ（可在 /admin/jobs 重放）
      this.deps.logger?.warn('queue.sqs.poison', { messageId: m.MessageId, receiveCount, reason: !env ? 'unparseable' : 'no-handler' });
      if (m.ReceiptHandle) await this.changeVisibility(m.ReceiptHandle, retryDelaySec(receiveCount)).catch(() => undefined);
      this.stats5m.failed += 1;
      return 'poison';
    }
    const gate = this.gates[env.name];
    const stopHeartbeat = this.startHeartbeat(m.ReceiptHandle);
    try {
      await gate.acquire();
      try {
        await handler({ ...env, attempt: receiveCount });
      } finally {
        gate.release();
      }
      stopHeartbeat();
      await this.deleteMessage(m.ReceiptHandle);
      this.stats5m.processed += 1;
      return 'deleted';
    } catch (e) {
      stopHeartbeat();
      this.stats5m.failed += 1;
      this.deps.logger?.warn('queue.sqs.job_failed', { job: env.name, jobId: env.id, receiveCount, error: (e as Error)?.message ?? String(e) });
      await this.changeVisibility(m.ReceiptHandle, retryDelaySec(receiveCount)).catch(() => undefined);
      return 'retry';
    }
  }

  private startHeartbeat(receiptHandle: string): () => void {
    const everyMs = Math.max(1000, (this.visibilityTimeoutSec * 1000) / 2);
    const timer = setInterval(() => {
      void this.changeVisibility(receiptHandle, this.visibilityTimeoutSec).catch(() => undefined);
    }, everyMs);
    timer.unref();
    return () => clearInterval(timer);
  }

  private async changeVisibility(receiptHandle: string, seconds: number): Promise<void> {
    const { ChangeMessageVisibilityCommand } = await this.sdk();
    const sqs = await this.client();
    await sqs.send(new ChangeMessageVisibilityCommand({
      QueueUrl: this.qcfg.SQS_QUEUE_URL, ReceiptHandle: receiptHandle, VisibilityTimeout: Math.max(0, Math.min(43_200, seconds)),
    }));
  }

  /** 成功的消息攒批删除（≤10 条或 50ms），减少请求数 */
  private deleteMessage(handle: string): Promise<void> {
    return new Promise<void>((resolve) => {
      this.pendingDeletes.push({ handle, resolve });
      if (this.pendingDeletes.length >= 10) void this.flushDeletes();
      else if (!this.deleteTimer) {
        this.deleteTimer = setTimeout(() => { void this.flushDeletes(); }, 50);
        this.deleteTimer.unref();
      }
    });
  }

  private async flushDeletes(): Promise<void> {
    if (this.deleteTimer) {
      clearTimeout(this.deleteTimer);
      this.deleteTimer = undefined;
    }
    while (this.pendingDeletes.length) {
      const batch = this.pendingDeletes.splice(0, 10);
      try {
        const { DeleteMessageBatchCommand, DeleteMessageCommand } = await this.sdk();
        const sqs = await this.client();
        const r = await sqs.send(new DeleteMessageBatchCommand({
          QueueUrl: this.qcfg.SQS_QUEUE_URL,
          Entries: batch.map((b, i) => ({ Id: String(i), ReceiptHandle: b.handle })),
        }));
        // 部分失败：逐条重试一次；仍失败则交给可见性超时（消息会再次投递，handler 幂等）
        for (const f of r.Failed ?? []) {
          const item = batch[Number(f.Id)];
          if (!item) continue;
          await sqs.send(new DeleteMessageCommand({ QueueUrl: this.qcfg.SQS_QUEUE_URL, ReceiptHandle: item.handle })).catch((e: unknown) => {
            this.deps.logger?.warn('queue.sqs.delete_failed', { code: f.Code, error: describeAwsError(e) });
          });
        }
      } catch (e) {
        this.deps.logger?.warn('queue.sqs.delete_batch_failed', { error: describeAwsError(e) });
      } finally {
        for (const b of batch) b.resolve();
      }
    }
  }

  // ------------------------------------------------------------------------------------------
  // 观测与运维
  // ------------------------------------------------------------------------------------------
  private async loadQueueAttributes(): Promise<void> {
    const { GetQueueAttributesCommand } = await this.sdk();
    const sqs = await this.client();
    const r = await sqs.send(new GetQueueAttributesCommand({ QueueUrl: this.qcfg.SQS_QUEUE_URL, AttributeNames: ['VisibilityTimeout', 'QueueArn'] }));
    const vt = Number(r.Attributes?.VisibilityTimeout);
    if (Number.isFinite(vt) && vt > 0) this.visibilityTimeoutSec = vt;
    if (r.Attributes?.QueueArn) this.queueArns.main = r.Attributes.QueueArn;
  }

  private async attributes(url: string, names: QueueAttributeName[]): Promise<Record<string, string>> {
    const { GetQueueAttributesCommand } = await this.sdk();
    const sqs = await this.client();
    const r = await sqs.send(new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: names }));
    return r.Attributes ?? {};
  }

  async stats(): Promise<{ depth: number; inFlight: number; dlqDepth?: number; oldestAgeSec?: number }> {
    const [main, dlq] = await Promise.all([
      this.attributes(this.qcfg.SQS_QUEUE_URL, ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible', 'ApproximateNumberOfMessagesDelayed']),
      this.attributes(this.qcfg.SQS_DLQ_URL, ['ApproximateNumberOfMessages']),
    ]);
    // 最老消息年龄需要 CloudWatch（ApproximateAgeOfOldestMessage，分钟级延迟）；本驱动不依赖 CloudWatch SDK，不提供 oldestAgeSec
    return {
      depth: Number(main.ApproximateNumberOfMessages ?? 0) + Number(main.ApproximateNumberOfMessagesDelayed ?? 0),
      inFlight: Number(main.ApproximateNumberOfMessagesNotVisible ?? 0),
      dlqDepth: Number(dlq.ApproximateNumberOfMessages ?? 0),
    };
  }

  /** 切换驱动前排空：等待队列中的可见与处理中消息都为 0（消费由 worker 完成，本方法只观察） */
  async drain(timeoutSec: number): Promise<{ remaining: number }> {
    const deadline = Date.now() + Math.max(0, timeoutSec) * 1000;
    for (;;) {
      const s = await this.stats();
      const remaining = s.depth + s.inFlight;
      if (remaining === 0 || Date.now() >= deadline) return { remaining };
      await sleep(Math.min(2000, Math.max(100, deadline - Date.now())));
    }
  }

  /** DLQ 一键重放（/admin/jobs）：StartMessageMoveTask（DLQ → 主队列）。返回任务句柄 */
  async replayDlq(opts: { maxPerSecond?: number } = {}): Promise<{ taskHandle?: string }> {
    const { StartMessageMoveTaskCommand } = await this.sdk();
    const [mainAttrs, dlqAttrs] = await Promise.all([
      this.attributes(this.qcfg.SQS_QUEUE_URL, ['QueueArn']),
      this.attributes(this.qcfg.SQS_DLQ_URL, ['QueueArn']),
    ]);
    if (!dlqAttrs.QueueArn || !mainAttrs.QueueArn) throw new HttpError(503, 'QUEUE_UNAVAILABLE', '读不到队列 ARN');
    const sqs = await this.client();
    const r = await sqs.send(new StartMessageMoveTaskCommand({
      SourceArn: dlqAttrs.QueueArn, DestinationArn: mainAttrs.QueueArn,
      ...(opts.maxPerSecond ? { MaxNumberOfMessagesPerSecond: opts.maxPerSecond } : {}),
    }));
    return r.TaskHandle ? { taskHandle: r.TaskHandle } : {};
  }

  async probe(_opts?: { deep?: boolean }): Promise<ProbeResult> {
    const t0 = performance.now();
    let main: Record<string, string>;
    let dlq: Record<string, string>;
    try {
      [main, dlq] = await Promise.all([
        this.attributes(this.qcfg.SQS_QUEUE_URL, [
          'ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible', 'ApproximateNumberOfMessagesDelayed',
          'QueueArn', 'VisibilityTimeout', 'RedrivePolicy',
        ]),
        this.attributes(this.qcfg.SQS_DLQ_URL, ['ApproximateNumberOfMessages', 'QueueArn', 'MessageRetentionPeriod']),
      ]);
    } catch (e) {
      const why = isAwsNotFound(e) ? '队列不存在' : isAwsAccessDenied(e) ? '无权限（检查 PolicyArn 的 sqs:GetQueueAttributes）' : describeAwsError(e);
      return { status: 'error', detail: `GetQueueAttributes 失败：${why}`, confidence: 'confirmed' };
    }
    const latencyMs = Math.round((performance.now() - t0) * 10) / 10;
    const visible = Number(main.ApproximateNumberOfMessages ?? 0);
    const notVisible = Number(main.ApproximateNumberOfMessagesNotVisible ?? 0);
    const delayed = Number(main.ApproximateNumberOfMessagesDelayed ?? 0);
    const dlqDepth = Number(dlq.ApproximateNumberOfMessages ?? 0);
    let maxReceiveCount: number | undefined;
    try {
      maxReceiveCount = Number((JSON.parse(main.RedrivePolicy ?? '{}') as { maxReceiveCount?: unknown }).maxReceiveCount) || undefined;
    } catch {
      maxReceiveCount = undefined;
    }
    if (main.QueueArn) this.queueArns.main = main.QueueArn;
    if (dlq.QueueArn) this.queueArns.dlq = dlq.QueueArn;
    const vt = Number(main.VisibilityTimeout);
    if (Number.isFinite(vt) && vt > 0) this.visibilityTimeoutSec = vt;
    const problems: string[] = [];
    if (dlqDepth > 0) problems.push(`DLQ 有 ${dlqDepth} 条死信`);
    if (!maxReceiveCount) problems.push('主队列没有 RedrivePolicy（失败消息不会进入 DLQ）');
    const detail = `可见 ${visible} · 处理中 ${notVisible}${delayed ? ` · 延迟 ${delayed}` : ''} · DLQ ${dlqDepth}` +
      `${maxReceiveCount ? ` · maxReceiveCount ${maxReceiveCount}` : ''}${problems.length ? ` · ${problems.join('；')}` : ''}`;
    return {
      status: problems.length ? 'degraded' : 'ok',
      detail,
      latencyMs,
      confidence: 'confirmed',
      data: {
        queueUrl: this.qcfg.SQS_QUEUE_URL, dlqUrl: this.qcfg.SQS_DLQ_URL, queueArn: main.QueueArn, dlqArn: dlq.QueueArn,
        visible, inFlight: notVisible, delayed, dlqDepth, visibilityTimeoutSec: this.visibilityTimeoutSec,
        ...(maxReceiveCount ? { maxReceiveCount } : {}),
        localInFlight: this.inFlight,
        consumed: { ...this.stats5m },
      },
    };
  }

  async close(): Promise<void> {
    this.internalAbort?.abort();
    await this.flushDeletes();
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
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
