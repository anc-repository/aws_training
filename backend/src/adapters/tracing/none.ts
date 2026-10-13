// backend/src/adapters/tracing/none.ts —— TracerPort 的 `none` 驱动（本地实现）
// span 为空操作（Server-Timing 由 instrument 代理独立生成）
// 脚手架桩：方法抛出 NotImplementedError（HTTP 层映射为 501）。由「L0 本地实现者」填充。
import type { AdapterDeps } from '../types.js';
import type { AdapterMeta, ProbeResult } from '../../ports/common.js';
import type { Span, TracerPort } from '../../ports/tracer.js';
import { notImplemented } from '../../errors.js';

export class NoTracer implements TracerPort {
  readonly meta: AdapterMeta = { module: 'tracing', driver: 'none', awsService: null, authoritative: false };

  constructor(protected readonly deps: AdapterDeps) {}

  async probe(_opts?: { deep?: boolean }): Promise<ProbeResult> {
    throw notImplemented('NoTracer', 'probe', 'tracing');
  }

  startSpan(_name: string, _opts?: { kind?: 'server' | 'client' | 'internal' | 'producer' | 'consumer'; attributes?: Record<string, string | number | boolean> }): Span {
    throw notImplemented('NoTracer', 'startSpan', 'tracing');
  }

  async withSpan<T>(_name: string, _fn: (span: Span) => Promise<T>, _attributes?: Record<string, string | number | boolean>): Promise<T> {
    throw notImplemented('NoTracer', 'withSpan', 'tracing');
  }

  currentTraceId(): string | undefined {
    throw notImplemented('NoTracer', 'currentTraceId', 'tracing');
  }

  inject(_carrier: Record<string, string>): void {
    throw notImplemented('NoTracer', 'inject', 'tracing');
  }

  extract(_carrier: Record<string, string>): void {
    throw notImplemented('NoTracer', 'extract', 'tracing');
  }
}
