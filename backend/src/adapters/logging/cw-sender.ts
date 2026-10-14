// backend/src/adapters/logging/cw-sender.ts —— CloudWatch Logs 的进程内批量发送器（05#logging 第 2 节“写入侧”）
//
// - 缓冲区按到达顺序排列（即时间顺序）；每 flushMs（LOG_CW_FLUSH_MS，默认 2 秒）或缓冲达到约 1 MiB / 5000 条时发送一批，
//   低于 PutLogEvents 的单批上限（大小、条数、批内时间跨度的上限以官方文档为准）。PutLogEvents 不再需要 sequence token。
// - 日志流在第一次发送前 CreateLogStream（已存在则忽略）；日志组由 CloudFormation 创建，应用不建组。
// - 失败按指数退避重试（1、2、4 … 60 秒）；积压超过 maxBacklog 时丢弃最旧的事件并计入 dropped。
//   日志是非权威端口：远端故障绝不阻塞请求，也不抛给调用方（总纲 1.2 原则 4），只体现在 stats() 与探针上。
// - 发送器自己的错误不写日志（否则会再产生要发送的日志），只记在 lastError。
import type { CloudWatchLogsClient } from '@aws-sdk/client-cloudwatch-logs';
import { awsErrorName, describeAwsError, isAwsAccessDenied, isAwsTransient, loadAwsPackage } from '../aws/clients.js';

type LogsSdk = typeof import('@aws-sdk/client-cloudwatch-logs');

/** 每条事件在批大小中额外计 26 字节（PutLogEvents 的计算方法，以官方文档为准） */
export const EVENT_OVERHEAD_BYTES = 26;
/** 单批字节上限留余量（官方上限约 1 MiB） */
export const MAX_BATCH_BYTES = 1_000_000;
export const MAX_BATCH_EVENTS = 5000;
/** 单条事件的截断长度（保守取 256 KiB 减去额外字节；上限以官方文档为准） */
export const MAX_EVENT_BYTES = 256 * 1024 - EVENT_OVERHEAD_BYTES;
/** 批内时间跨度上限 24 小时，留 1 小时余量 */
const MAX_BATCH_SPAN_MS = 23 * 3600_000;
const MAX_BACKOFF_MS = 60_000;

export interface QueuedEvent { seq: number; timestamp: number; message: string; bytes: number }

export interface SenderStats {
  group: string;
  stream: string;
  /** 远端确认收下的事件数 */
  sent: number;
  /** 因积压上限丢弃、或被 PutLogEvents 拒绝（太旧 / 太新 / 已过期）的事件数 */
  dropped: number;
  backlog: number;
  backlogBytes: number;
  lastRemoteSuccessAt?: string;
  lastAttemptAt?: string;
  lastError?: string;
  lastErrorName?: string;
  consecutiveFailures: number;
  /** 最近一次失败是“日志组不存在” */
  groupMissing: boolean;
  /** 最近一次失败是权限不足（确定性失败） */
  accessDenied: boolean;
}

export interface SenderOptions {
  group: string;
  /** 每次发送时求值：实例身份可能在 logger 初始化之后才确定（container 先建 logger，后读 IMDS） */
  stream: () => string;
  flushMs: number;
  maxBacklog: number;
  client: () => Promise<CloudWatchLogsClient>;
  sdk?: () => Promise<LogsSdk>;
  now?: () => number;
  maxBatchEvents?: number;
  maxBatchBytes?: number;
  /** 测试：关闭定时器，只由 flush() / sendOnce() 驱动 */
  timer?: boolean;
}

function utf8Length(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

/** 超长事件截断（保留合法 UTF-8 前缀），并加上标记 */
export function truncateMessage(message: string, maxBytes = MAX_EVENT_BYTES): string {
  if (utf8Length(message) <= maxBytes) return message;
  const marker = '…[truncated]';
  const buf = Buffer.from(message, 'utf8').subarray(0, maxBytes - utf8Length(marker));
  return `${buf.toString('utf8').replace(/�+$/, '')}${marker}`;
}

export class CwLogSender {
  private readonly queue: QueuedEvent[] = [];
  private queueBytes = 0;
  private seq = 0;
  private sent = 0;
  private dropped = 0;
  private consecutiveFailures = 0;
  private nextAttemptAt = 0;
  private lastRemoteSuccessAt?: number;
  private lastAttemptAt?: number;
  private lastError?: string;
  private lastErrorName?: string;
  private groupMissing = false;
  private accessDenied = false;
  private readonly createdStreams = new Set<string>();
  private inflight: Promise<boolean> | undefined;
  private timer: NodeJS.Timeout | undefined;
  private kick: NodeJS.Immediate | undefined;
  private readonly now: () => number;
  private readonly maxEvents: number;
  private readonly maxBytes: number;

  constructor(private readonly opts: SenderOptions) {
    this.now = opts.now ?? (() => Date.now());
    this.maxEvents = opts.maxBatchEvents ?? MAX_BATCH_EVENTS;
    this.maxBytes = opts.maxBatchBytes ?? MAX_BATCH_BYTES;
  }

  get group(): string {
    return this.opts.group;
  }

  start(): void {
    if (this.timer || this.opts.timer === false) return;
    this.timer = setInterval(() => { void this.tick(); }, Math.max(100, this.opts.flushMs));
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.kick) clearImmediate(this.kick);
    this.kick = undefined;
  }

  /** 入队（热路径：O(1)，不做 I/O） */
  enqueue(message: string, timestamp = this.now()): void {
    const text = truncateMessage(message.endsWith('\n') ? message.slice(0, -1) : message);
    if (!text) return;
    const ev: QueuedEvent = { seq: (this.seq += 1), timestamp, message: text, bytes: utf8Length(text) + EVENT_OVERHEAD_BYTES };
    this.queue.push(ev);
    this.queueBytes += ev.bytes;
    while (this.queue.length > this.opts.maxBacklog) {
      const old = this.queue.shift()!;
      this.queueBytes -= old.bytes;
      this.dropped += 1;
    }
    if ((this.queue.length >= this.maxEvents || this.queueBytes >= this.maxBytes) && !this.kick && this.opts.timer !== false) {
      this.kick = setImmediate(() => {
        this.kick = undefined;
        void this.tick();
      });
      this.kick.unref?.();
    }
  }

  stats(): SenderStats {
    return {
      group: this.opts.group,
      stream: this.safeStream(),
      sent: this.sent,
      dropped: this.dropped,
      backlog: this.queue.length,
      backlogBytes: this.queueBytes,
      ...(this.lastRemoteSuccessAt ? { lastRemoteSuccessAt: new Date(this.lastRemoteSuccessAt).toISOString() } : {}),
      ...(this.lastAttemptAt ? { lastAttemptAt: new Date(this.lastAttemptAt).toISOString() } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
      ...(this.lastErrorName ? { lastErrorName: this.lastErrorName } : {}),
      consecutiveFailures: this.consecutiveFailures,
      groupMissing: this.groupMissing,
      accessDenied: this.accessDenied,
    };
  }

  private safeStream(): string {
    try {
      return this.opts.stream();
    } catch {
      return 'unknown';
    }
  }

  /** 定时器：退避期内不发；一次 tick 最多连续发送到队列不足一批 */
  private async tick(): Promise<void> {
    if (this.inflight || !this.queue.length || this.now() < this.nextAttemptAt) return;
    let ok = await this.sendOnce();
    while (ok && (this.queue.length >= this.maxEvents || this.queueBytes >= this.maxBytes)) ok = await this.sendOnce();
  }

  /**
   * 发送队首的一批；返回是否成功。同一时刻只有一个请求在途（PutLogEvents 对同一日志流并发写入没有好处）。
   */
  sendOnce(): Promise<boolean> {
    if (this.inflight) return this.inflight;
    if (!this.queue.length) return Promise.resolve(true);
    const p = this.doSend().finally(() => { this.inflight = undefined; });
    this.inflight = p;
    return p;
  }

  private takeBatch(): QueuedEvent[] {
    const batch: QueuedEvent[] = [];
    let bytes = 0;
    const first = this.queue[0]!.timestamp;
    for (const ev of this.queue) {
      if (batch.length >= this.maxEvents || bytes + ev.bytes > this.maxBytes) break;
      if (ev.timestamp - first > MAX_BATCH_SPAN_MS) break;
      batch.push(ev);
      bytes += ev.bytes;
    }
    if (!batch.length) batch.push(this.queue[0]!);
    return batch;
  }

  private async doSend(): Promise<boolean> {
    const sdk = await (this.opts.sdk ?? (() => loadAwsPackage('@aws-sdk/client-cloudwatch-logs', () => import('@aws-sdk/client-cloudwatch-logs'))))();
    const batch = this.takeBatch();
    const stream = this.safeStream();
    this.lastAttemptAt = this.now();
    try {
      const client = await this.opts.client();
      if (!this.createdStreams.has(stream)) {
        try {
          await client.send(new sdk.CreateLogStreamCommand({ logGroupName: this.opts.group, logStreamName: stream }));
        } catch (e) {
          if (awsErrorName(e) !== 'ResourceAlreadyExistsException') throw e;
        }
        this.createdStreams.add(stream);
      }
      // 事件必须按时间升序；入队顺序通常就是时间顺序，这里再稳定排序一次（尾随的 nginx 行可能晚于应用日志到达）
      const events = batch.map((e) => ({ timestamp: e.timestamp, message: e.message })).sort((a, b) => a.timestamp - b.timestamp);
      const r = await client.send(new sdk.PutLogEventsCommand({ logGroupName: this.opts.group, logStreamName: stream, logEvents: events }));
      // 在途期间积压上限可能已从队首丢弃了一部分：按序号移除本批，而不是按条数
      const lastSeq = batch[batch.length - 1]!.seq;
      let removed = 0;
      while (this.queue.length && this.queue[0]!.seq <= lastSeq) {
        this.queueBytes -= this.queue.shift()!.bytes;
        removed += 1;
      }
      const rejected = rejectedCount(r.rejectedLogEventsInfo, events.length);
      this.sent += Math.max(0, removed - rejected);
      this.dropped += rejected;
      this.consecutiveFailures = 0;
      this.nextAttemptAt = 0;
      this.groupMissing = false;
      this.accessDenied = false;
      this.lastRemoteSuccessAt = this.now();
      return true;
    } catch (e) {
      const name = awsErrorName(e);
      const message = (e as Error)?.message ?? String(e);
      this.consecutiveFailures += 1;
      this.lastError = describeAwsError(e);
      this.lastErrorName = name;
      this.accessDenied = isAwsAccessDenied(e);
      if (name === 'ResourceNotFoundException') {
        // 日志流被删掉（下次重建）或日志组不存在（栈被删除 / 名称写错）
        this.createdStreams.delete(stream);
        this.groupMissing = /log group/i.test(message);
      } else {
        this.groupMissing = false;
      }
      const base = isAwsTransient(e) || name === 'ResourceNotFoundException' ? 1000 : 5000;
      this.nextAttemptAt = this.now() + Math.min(MAX_BACKOFF_MS, base * 2 ** Math.min(this.consecutiveFailures - 1, 6));
      return false;
    }
  }

  /**
   * 尽量发完（SIGTERM / 测试）：按批发送直到队列为空、发送失败或超过 timeoutMs。不抛出。
   * 失败后等待退避时间，最多重试 2 次，然后放弃（事件仍留在队列中，本地文件照写，没有数据缺口）。
   */
  async flush(timeoutMs = 10_000): Promise<void> {
    const deadline = this.now() + timeoutMs;
    let retries = 0;
    while (this.queue.length && this.now() < deadline) {
      const ok = await this.sendOnce();
      if (ok) continue;
      retries += 1;
      if (retries > 2 || this.accessDenied || this.groupMissing) return;
      const wait = Math.min(this.nextAttemptAt - this.now(), deadline - this.now(), 2000);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
  }
}

function rejectedCount(info: { tooNewLogEventStartIndex?: number; tooOldLogEventEndIndex?: number; expiredLogEventEndIndex?: number } | undefined, n: number): number {
  if (!info) return 0;
  const rejected = new Set<number>();
  if (info.tooOldLogEventEndIndex !== undefined) for (let i = 0; i < Math.min(n, info.tooOldLogEventEndIndex + 1); i += 1) rejected.add(i);
  if (info.expiredLogEventEndIndex !== undefined) for (let i = 0; i < Math.min(n, info.expiredLogEventEndIndex + 1); i += 1) rejected.add(i);
  if (info.tooNewLogEventStartIndex !== undefined) for (let i = Math.max(0, info.tooNewLogEventStartIndex); i < n; i += 1) rejected.add(i);
  return rejected.size;
}
