// backend/src/adapters/queue/memory.ts —— QueuePort 的 `memory` 驱动（本地实现）
// 本地档：api 进程内队列，最多一次，重启即丢
// 脚手架桩：方法抛出 NotImplementedError（HTTP 层映射为 501）。由「queue 模块实现者（本地档）」填充。
import type { AdapterDeps } from '../types.js';
import type { AdapterMeta, ProbeResult } from '../../ports/common.js';
import type { JobHandler, JobName, QueuePort } from '../../ports/queue.js';
import { notImplemented } from '../../errors.js';

export class MemoryQueue implements QueuePort {
  readonly meta: AdapterMeta = { module: 'queue', driver: 'memory', awsService: null, authoritative: true };
  readonly semantics: QueuePort['semantics'] = { durable: false, consumer: 'api', delivery: 'at-most-once' };

  constructor(protected readonly deps: AdapterDeps) {}

  async probe(_opts?: { deep?: boolean }): Promise<ProbeResult> {
    throw notImplemented('MemoryQueue', 'probe', 'queue');
  }

  bind(_handlers: Partial<Record<JobName, JobHandler>>): void {
    throw notImplemented('MemoryQueue', 'bind', 'queue');
  }

  async enqueue<P>(_name: JobName, _payload: P, _opts?: { delaySec?: number; dedupKey?: string }): Promise<{ jobId: string; mode: 'inline' | 'queued' }> {
    throw notImplemented('MemoryQueue', 'enqueue', 'queue');
  }

  async consume(_opts: { concurrency: number; signal: AbortSignal }): Promise<void> {
    throw notImplemented('MemoryQueue', 'consume', 'queue');
  }

  async stats(): Promise<{ depth: number; inFlight: number; dlqDepth?: number; oldestAgeSec?: number }> {
    throw notImplemented('MemoryQueue', 'stats', 'queue');
  }

  async drain(_timeoutSec: number): Promise<{ remaining: number }> {
    throw notImplemented('MemoryQueue', 'drain', 'queue');
  }
}
