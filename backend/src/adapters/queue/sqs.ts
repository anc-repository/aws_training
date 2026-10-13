// backend/src/adapters/queue/sqs.ts —— QueuePort 的 `sqs` 驱动（Amazon SQS）
// SQS 标准队列 + DLQ，worker 长轮询消费，至少一次投递
// 脚手架桩：方法抛出 NotImplementedError（HTTP 层映射为 501）。由「queue 模块实现者」填充。
import type { AdapterDeps } from '../types.js';
import type { AdapterMeta, ProbeResult } from '../../ports/common.js';
import type { JobHandler, JobName, QueuePort } from '../../ports/queue.js';
import { notImplemented } from '../../errors.js';

export class SqsQueue implements QueuePort {
  readonly meta: AdapterMeta = { module: 'queue', driver: 'sqs', awsService: 'Amazon SQS', authoritative: true };
  readonly semantics: QueuePort['semantics'] = { durable: true, consumer: 'worker', delivery: 'at-least-once' };

  constructor(protected readonly deps: AdapterDeps) {}

  async probe(_opts?: { deep?: boolean }): Promise<ProbeResult> {
    throw notImplemented('SqsQueue', 'probe', 'queue');
  }

  bind(_handlers: Partial<Record<JobName, JobHandler>>): void {
    throw notImplemented('SqsQueue', 'bind', 'queue');
  }

  async enqueue<P>(_name: JobName, _payload: P, _opts?: { delaySec?: number; dedupKey?: string }): Promise<{ jobId: string; mode: 'inline' | 'queued' }> {
    throw notImplemented('SqsQueue', 'enqueue', 'queue');
  }

  async consume(_opts: { concurrency: number; signal: AbortSignal }): Promise<void> {
    throw notImplemented('SqsQueue', 'consume', 'queue');
  }

  async stats(): Promise<{ depth: number; inFlight: number; dlqDepth?: number; oldestAgeSec?: number }> {
    throw notImplemented('SqsQueue', 'stats', 'queue');
  }

  async drain(_timeoutSec: number): Promise<{ remaining: number }> {
    throw notImplemented('SqsQueue', 'drain', 'queue');
  }
}
