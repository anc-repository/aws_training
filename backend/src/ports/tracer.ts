// backend/src/ports/tracer.ts （总纲 §4.2，照录）
import type { Adapter } from './common.js';

type Attr = string | number | boolean;
export interface Span {
  readonly traceId: string; readonly spanId: string;
  setAttribute(k: string, v: Attr): void; recordError(e: unknown): void; end(): void;
}
export interface TracerPort extends Adapter {
  startSpan(name: string, opts?: { kind?: 'server' | 'client' | 'internal' | 'producer' | 'consumer'; attributes?: Record<string, Attr> }): Span;
  withSpan<T>(name: string, fn: (span: Span) => Promise<T>, attributes?: Record<string, Attr>): Promise<T>;
  currentTraceId(): string | undefined;          // xray 档为 X-Ray 格式（1-xxxxxxxx-...）
  inject(carrier: Record<string, string>): void; // 传播到 SQS 消息属性、Lambda 回调
  extract(carrier: Record<string, string>): void;
}
// none 档：span 为空操作；Server-Timing 由 instrument 代理独立生成，不依赖 TracerPort。
// local 档（本地档）：OTel SDK + FileSpanExporter 写 logs/spans/，/lab 画本机 span 树；xray 档经本机 Collector 导出。
// local / xray 档由 systemd drop-in 注入 NODE_OPTIONS=--import register.js（先注册 import-in-the-middle 钩子）。
// SQS→worker 经 JobEnvelope.traceparent 续接同一条 trace；S3→EventBridge→Lambda 是另一条 trace，用 photo_id 注解关联。
// 只读侧 TraceReader（/api/lab/traces）：local 读 span 文件，xray 读 GetTraceSummaries。
