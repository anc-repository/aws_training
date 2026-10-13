// backend/src/adapters/logging/file.ts —— LoggerPort 的 `file` 驱动（本地实现）
// pino → CLOUDALBUM_DATA_DIR/logs/<role>.log（logrotate 轮转）；字段自动附加 requestId / role / X-CloudAlbum-Path
// 脚手架桩：方法抛出 NotImplementedError（HTTP 层映射为 501）。由「L0 本地实现者」填充。
import type { AdapterDeps } from '../types.js';
import type { AdapterMeta, ProbeResult } from '../../ports/common.js';
import type { LogLevel, Logger, LoggerPort } from '../../ports/logger.js';
import { notImplemented } from '../../errors.js';

export class FileLogger implements LoggerPort {
  readonly meta: AdapterMeta = { module: 'logging', driver: 'file', awsService: null, authoritative: false };

  constructor(protected readonly deps: AdapterDeps) {}

  async probe(_opts?: { deep?: boolean }): Promise<ProbeResult> {
    throw notImplemented('FileLogger', 'probe', 'logging');
  }

  log(_level: LogLevel, _msg: string, _fields?: Record<string, unknown>): void {
    throw notImplemented('FileLogger', 'log', 'logging');
  }

  debug(_msg: string, _fields?: Record<string, unknown>): void {
    throw notImplemented('FileLogger', 'debug', 'logging');
  }

  info(_msg: string, _fields?: Record<string, unknown>): void {
    throw notImplemented('FileLogger', 'info', 'logging');
  }

  warn(_msg: string, _fields?: Record<string, unknown>): void {
    throw notImplemented('FileLogger', 'warn', 'logging');
  }

  error(_msg: string, _fields?: Record<string, unknown>): void {
    throw notImplemented('FileLogger', 'error', 'logging');
  }

  child(_bindings: Record<string, unknown>): Logger {
    throw notImplemented('FileLogger', 'child', 'logging');
  }

  async flush(): Promise<void> {
    throw notImplemented('FileLogger', 'flush', 'logging');
  }

  stats(): { written: number; dropped: number; backlog: number; lastRemoteSuccessAt?: string } {
    throw notImplemented('FileLogger', 'stats', 'logging');
  }
}
