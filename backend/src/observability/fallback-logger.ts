// backend/src/observability/fallback-logger.ts —— 兜底日志
//
// container 内部（以及 CLI）使用的 Logger：优先写 LoggerPort（logging 模块的驱动）；驱动尚未实现（脚手架桩抛出
// NotImplementedError）或写入失败时，退回 stderr 上的 JSON 行，保证骨架在任何阶段都能启动并留下日志。
import { isNotImplemented } from '../errors.js';
import type { LogLevel, Logger, LoggerPort } from '../ports/logger.js';
import { currentContext } from './request-context.js';

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function consoleLogger(bindings: Record<string, unknown> = {}, minLevel: LogLevel = 'info'): Logger {
  const write = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => {
    if (LEVELS[level] < LEVELS[minLevel]) return;
    const ctx = currentContext();
    const line = {
      ts: new Date().toISOString(), level, msg, ...bindings,
      ...(ctx ? { requestId: ctx.requestId } : {}),
      ...(fields ?? {}),
    };
    process.stderr.write(`${JSON.stringify(line, (_k, v: unknown) => (v instanceof Error ? { name: v.name, message: v.message } : v))}\n`);
  };
  return {
    log: write,
    debug: (m, f) => write('debug', m, f),
    info: (m, f) => write('info', m, f),
    warn: (m, f) => write('warn', m, f),
    error: (m, f) => write('error', m, f),
    child: (b) => consoleLogger({ ...bindings, ...b }, minLevel),
  };
}

/** 包装 LoggerPort：调用失败时退回 consoleLogger（只提示一次） */
export function safeLogger(port: LoggerPort | undefined, bindings: Record<string, unknown> = {}, minLevel: LogLevel = 'info'): Logger {
  const fallback = consoleLogger(bindings, minLevel);
  let warned = false;
  const call = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => {
    if (port) {
      try {
        port.log(level, msg, { ...bindings, ...(fields ?? {}) });
        return;
      } catch (e) {
        if (!warned) {
          warned = true;
          fallback.warn(isNotImplemented(e) ? 'LoggerPort 尚未实现，日志改写到 stderr' : 'LoggerPort 写入失败，日志改写到 stderr',
            { error: (e as Error).message });
        }
      }
    }
    fallback.log(level, msg, fields);
  };
  return {
    log: call,
    debug: (m, f) => call('debug', m, f),
    info: (m, f) => call('info', m, f),
    warn: (m, f) => call('warn', m, f),
    error: (m, f) => call('error', m, f),
    child: (b) => safeLogger(port, { ...bindings, ...b }, minLevel),
  };
}
