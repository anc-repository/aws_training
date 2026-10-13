// backend/src/adapters/logging/cloudwatch.ts —— LoggerPort 的 `cloudwatch` 驱动（Amazon CloudWatch Logs）
// 本地文件照写 + 批量 PutLogEvents（本轮未实现）
// 脚手架桩：方法抛出 NotImplementedError（HTTP 层映射为 501）。由「后续版本（本轮 MVP 不实现；配置该驱动会被 config/implemented.ts 以 CFG-001 拒绝）」填充。
import type { AdapterDeps } from '../types.js';
import type { AdapterMeta, ProbeResult } from '../../ports/common.js';
import type { LogLevel, Logger, LoggerPort } from '../../ports/logger.js';
import { notImplemented } from '../../errors.js';

export class CwLogger implements LoggerPort {
  readonly meta: AdapterMeta = { module: 'logging', driver: 'cloudwatch', awsService: 'Amazon CloudWatch Logs', authoritative: false };

  constructor(protected readonly deps: AdapterDeps) {}

  async probe(_opts?: { deep?: boolean }): Promise<ProbeResult> {
    throw notImplemented('CwLogger', 'probe', 'logging');
  }

  log(_level: LogLevel, _msg: string, _fields?: Record<string, unknown>): void {
    throw notImplemented('CwLogger', 'log', 'logging');
  }

  debug(_msg: string, _fields?: Record<string, unknown>): void {
    throw notImplemented('CwLogger', 'debug', 'logging');
  }

  info(_msg: string, _fields?: Record<string, unknown>): void {
    throw notImplemented('CwLogger', 'info', 'logging');
  }

  warn(_msg: string, _fields?: Record<string, unknown>): void {
    throw notImplemented('CwLogger', 'warn', 'logging');
  }

  error(_msg: string, _fields?: Record<string, unknown>): void {
    throw notImplemented('CwLogger', 'error', 'logging');
  }

  child(_bindings: Record<string, unknown>): Logger {
    throw notImplemented('CwLogger', 'child', 'logging');
  }

  async flush(): Promise<void> {
    throw notImplemented('CwLogger', 'flush', 'logging');
  }

  stats(): { written: number; dropped: number; backlog: number; lastRemoteSuccessAt?: string } {
    throw notImplemented('CwLogger', 'stats', 'logging');
  }
}
