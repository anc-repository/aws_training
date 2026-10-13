// backend/src/adapters/tracing/none.ts —— TracerPort 的 `none` 驱动（本地实现，05#tracing 第 1 节）
//
// span 为空操作：不加载 OTel、不写 span 文件、不传播 traceparent。Server-Timing 由 instrument 代理独立生成，
// 所以 L0 仍有“单跳”耗时分解；跨进程 / 跨服务的链路要启用本地档 local 或 xray。
import type { AdapterDeps } from '../types.js';
import type { AdapterMeta, ProbeResult } from '../../ports/common.js';
import type { Span, TracerPort } from '../../ports/tracer.js';

type Attr = string | number | boolean;

export const NOOP_SPAN: Span = Object.freeze({
  traceId: '',
  spanId: '',
  setAttribute(_k: string, _v: Attr): void {},
  recordError(_e: unknown): void {},
  end(): void {},
});

export class NoTracer implements TracerPort {
  readonly meta: AdapterMeta = { module: 'tracing', driver: 'none', awsService: null, authoritative: false };

  constructor(protected readonly deps: AdapterDeps) {}

  startSpan(_name: string, _opts?: { kind?: 'server' | 'client' | 'internal' | 'producer' | 'consumer'; attributes?: Record<string, Attr> }): Span {
    return NOOP_SPAN;
  }

  async withSpan<T>(_name: string, fn: (span: Span) => Promise<T>, _attributes?: Record<string, Attr>): Promise<T> {
    return fn(NOOP_SPAN);
  }

  currentTraceId(): string | undefined {
    return undefined;
  }

  inject(_carrier: Record<string, string>): void {}

  extract(_carrier: Record<string, string>): void {}

  async probe(_opts?: { deep?: boolean }): Promise<ProbeResult> {
    return { status: 'ok', detail: '不记录 span（只有单跳 Server-Timing）；本地档 local 记录本机 span 树' };
  }
}
