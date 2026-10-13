// backend/src/ports/queue.ts （总纲 §4.2，照录）
import type { Adapter } from './common.js';

export type JobName = 'image.process' | 'image.tag' | 'notify.fanout' | 'email.send' | 'analytics.flush';
export interface JobEnvelope<P = unknown> {
  id: string; name: JobName; payload: P; attempt: number; enqueuedAt: string;
  traceparent?: string;              // W3C Trace Context，由 TracerPort 注入
  dedupKey?: string;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type JobHandler<P = any> = (job: JobEnvelope<P>) => Promise<void>;

export interface QueuePort extends Adapter {
  /** 语义差异本身就是对比内容：sync 当场执行；memory 不持久、最多一次；sqs 持久、至少一次 */
  readonly semantics: {
    durable: boolean;
    consumer: 'inline' | 'api' | 'worker';
    delivery: 'inline' | 'at-most-once' | 'at-least-once';
  };
  bind(handlers: Partial<Record<JobName, JobHandler>>): void;      // sync 驱动入队即执行，必须先 bind
  enqueue<P>(name: JobName, payload: P,
             opts?: { delaySec?: number; dedupKey?: string }): Promise<{ jobId: string; mode: 'inline' | 'queued' }>;
  consume(opts: { concurrency: number; signal: AbortSignal }): Promise<void>;   // 阻塞直到 signal 终止
  stats(): Promise<{ depth: number; inFlight: number; dlqDepth?: number; oldestAgeSec?: number }>;
  drain(timeoutSec: number): Promise<{ remaining: number }>;        // 切换驱动前排空
}
