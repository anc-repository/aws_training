// backend/src/adapters/tracing/local.ts —— TracerPort 的 `local` 驱动（本地实现）
// 本地档：OTel SDK + FileSpanExporter（本轮未实现）
// 脚手架桩：方法抛出 NotImplementedError（HTTP 层映射为 501）。由「L0 本地实现者」填充。
import type { AdapterDeps } from '../types.js';
import type { AdapterMeta, ProbeResult } from '../../ports/common.js';
import type { Span, TracerPort } from '../../ports/tracer.js';
import { notImplemented } from '../../errors.js';

export class LocalTracer implements TracerPort {
  readonly meta: AdapterMeta = { module: 'tracing', driver: 'local', awsService: null, authoritative: false };

  constructor(protected readonly deps: AdapterDeps) {}

  async probe(_opts?: { deep?: boolean }): Promise<ProbeResult> {
    throw notImplemented('LocalTracer', 'probe', 'tracing');
  }

  startSpan(_name: string, _opts?: { kind?: 'server' | 'client' | 'internal' | 'producer' | 'consumer'; attributes?: Record<string, string | number | boolean> }): Span {
    throw notImplemented('LocalTracer', 'startSpan', 'tracing');
  }

  async withSpan<T>(_name: string, _fn: (span: Span) => Promise<T>, _attributes?: Record<string, string | number | boolean>): Promise<T> {
    throw notImplemented('LocalTracer', 'withSpan', 'tracing');
  }

  currentTraceId(): string | undefined {
    throw notImplemented('LocalTracer', 'currentTraceId', 'tracing');
  }

  inject(_carrier: Record<string, string>): void {
    throw notImplemented('LocalTracer', 'inject', 'tracing');
  }

  extract(_carrier: Record<string, string>): void {
    throw notImplemented('LocalTracer', 'extract', 'tracing');
  }
}
