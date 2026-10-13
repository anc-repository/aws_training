// backend/src/adapters/tracing/xray.ts —— TracerPort 的 `xray` 驱动（AWS X-Ray）
// 本轮未实现
// 脚手架桩：方法抛出 NotImplementedError（HTTP 层映射为 501）。由「后续版本（本轮 MVP 不实现；配置该驱动会被 config/implemented.ts 以 CFG-001 拒绝）」填充。
import type { AdapterDeps } from '../types.js';
import type { AdapterMeta, ProbeResult } from '../../ports/common.js';
import type { Span, TracerPort } from '../../ports/tracer.js';
import { notImplemented } from '../../errors.js';

export class XrayTracer implements TracerPort {
  readonly meta: AdapterMeta = { module: 'tracing', driver: 'xray', awsService: 'AWS X-Ray', authoritative: false };

  constructor(protected readonly deps: AdapterDeps) {}

  async probe(_opts?: { deep?: boolean }): Promise<ProbeResult> {
    throw notImplemented('XrayTracer', 'probe', 'tracing');
  }

  startSpan(_name: string, _opts?: { kind?: 'server' | 'client' | 'internal' | 'producer' | 'consumer'; attributes?: Record<string, string | number | boolean> }): Span {
    throw notImplemented('XrayTracer', 'startSpan', 'tracing');
  }

  async withSpan<T>(_name: string, _fn: (span: Span) => Promise<T>, _attributes?: Record<string, string | number | boolean>): Promise<T> {
    throw notImplemented('XrayTracer', 'withSpan', 'tracing');
  }

  currentTraceId(): string | undefined {
    throw notImplemented('XrayTracer', 'currentTraceId', 'tracing');
  }

  inject(_carrier: Record<string, string>): void {
    throw notImplemented('XrayTracer', 'inject', 'tracing');
  }

  extract(_carrier: Record<string, string>): void {
    throw notImplemented('XrayTracer', 'extract', 'tracing');
  }
}
