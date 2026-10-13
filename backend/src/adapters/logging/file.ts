// backend/src/adapters/logging/file.ts —— LoggerPort 的 `file` 驱动（本地实现，05#logging 第 1 节）
//
// pino → LOG_DIR/<role>.log（api.log / worker.log / cli.log；logrotate 每日轮转保留 14 天，copytruncate）。
// 每行自动附加 role、pid、instanceId、requestId（请求上下文中）。级别取运行时配置 logLevel（ConfigPort 热键，每次写入时读取
// 内存快照）。构造函数不做 I/O：目录与文件在 init()（或第一次写入）时创建；写不了时抛出，由 container 的 safeLogger 退回 stderr。
import { accessSync, constants as fsConstants, mkdirSync } from 'node:fs';
import path from 'node:path';
import pino, { type DestinationStream, type Logger as PinoLogger } from 'pino';
import type { AdapterDeps } from '../types.js';
import type { AdapterMeta, ProbeResult } from '../../ports/common.js';
import type { LogLevel, Logger, LoggerPort } from '../../ports/logger.js';
import { instanceIdentity } from '../../observability/path-header.js';
import { currentContext } from '../../observability/request-context.js';

const LEVELS: Record<LogLevel, number> = { debug: 20, info: 30, warn: 40, error: 50 };

type SonicLike = DestinationStream & { flush?: (cb?: (err?: Error) => void) => void; flushSync?: () => void; end?: () => void };

function serializeFields(fields: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!fields) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    out[k] = v instanceof Error ? { name: v.name, message: v.message, ...(v.stack ? { stack: v.stack } : {}) } : v;
  }
  return out;
}

class BoundLogger implements Logger {
  constructor(private readonly root: FileLogger, private readonly bindings: Record<string, unknown>) {}
  log(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
    this.root.log(level, msg, { ...this.bindings, ...(fields ?? {}) });
  }
  debug(msg: string, fields?: Record<string, unknown>): void { this.log('debug', msg, fields); }
  info(msg: string, fields?: Record<string, unknown>): void { this.log('info', msg, fields); }
  warn(msg: string, fields?: Record<string, unknown>): void { this.log('warn', msg, fields); }
  error(msg: string, fields?: Record<string, unknown>): void { this.log('error', msg, fields); }
  child(bindings: Record<string, unknown>): Logger { return new BoundLogger(this.root, { ...this.bindings, ...bindings }); }
}

export class FileLogger implements LoggerPort {
  readonly meta: AdapterMeta = { module: 'logging', driver: 'file', awsService: null, authoritative: false };
  private pino: PinoLogger | undefined;
  private dest: SonicLike | undefined;
  private written = 0;
  private dropped = 0;
  private lastError: string | undefined;

  constructor(protected readonly deps: AdapterDeps) {}

  get logDir(): string {
    return this.deps.cfg.logging.LOG_DIR;
  }

  get file(): string {
    return path.join(this.logDir, `${this.deps.role}.log`);
  }

  async init(): Promise<void> {
    this.ensureOpen();
  }

  private ensureOpen(): PinoLogger {
    if (this.pino) return this.pino;
    mkdirSync(this.logDir, { recursive: true });
    const dest = pino.destination({ dest: this.file, sync: false, mkdir: true }) as SonicLike;
    (dest as unknown as NodeJS.EventEmitter).on?.('error', (e: Error) => {
      this.dropped += 1;
      this.lastError = e.message;
    });
    this.dest = dest;
    this.pino = pino({
      level: 'debug',
      base: { role: this.deps.role, pid: process.pid },
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: { level: (label) => ({ level: label }) },
    }, dest);
    return this.pino;
  }

  private minLevel(): LogLevel {
    try {
      return this.deps.runtime?.current().logLevel ?? 'info';
    } catch {
      return 'info';
    }
  }

  log(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
    if (LEVELS[level] < LEVELS[this.minLevel()]) return;
    const p = this.ensureOpen();
    const ctx = currentContext();
    const inst = instanceIdentity().instanceId;
    p[level]({
      ...(inst ? { instanceId: inst } : {}),
      ...(ctx ? { requestId: ctx.requestId } : {}),
      ...serializeFields(fields),
    }, msg);
    this.written += 1;
  }

  debug(msg: string, fields?: Record<string, unknown>): void { this.log('debug', msg, fields); }
  info(msg: string, fields?: Record<string, unknown>): void { this.log('info', msg, fields); }
  warn(msg: string, fields?: Record<string, unknown>): void { this.log('warn', msg, fields); }
  error(msg: string, fields?: Record<string, unknown>): void { this.log('error', msg, fields); }

  child(bindings: Record<string, unknown>): Logger {
    return new BoundLogger(this, bindings);
  }

  async flush(): Promise<void> {
    const d = this.dest;
    if (!d?.flush) return;
    await new Promise<void>((resolve) => {
      try {
        d.flush!(() => resolve());
      } catch {
        resolve();                     // SonicBoom 尚未就绪（文件还没打开）时 flush 会抛出，忽略
      }
    });
  }

  stats(): { written: number; dropped: number; backlog: number; lastRemoteSuccessAt?: string } {
    return { written: this.written, dropped: this.dropped, backlog: 0 };
  }

  async probe(_opts?: { deep?: boolean }): Promise<ProbeResult> {
    try {
      mkdirSync(this.logDir, { recursive: true });
      accessSync(this.logDir, fsConstants.W_OK);
    } catch (e) {
      return { status: 'error', detail: `日志目录不可写：${this.logDir}（${(e as Error).message}）` };
    }
    const data = { file: this.file, written: this.written, dropped: this.dropped, ...(this.lastError ? { lastError: this.lastError } : {}) };
    if (this.dropped > 0) return { status: 'degraded', detail: `写日志失败 ${this.dropped} 次：${this.lastError ?? ''}`, data };
    return { status: 'ok', detail: `本机文件 ${this.file}（logrotate 每日轮转，保留 14 天；登录这台机器才能看）`, data };
  }
}
