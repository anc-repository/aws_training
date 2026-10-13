// backend/src/ports/logger.ts （总纲 §4.2，照录）
import type { Adapter } from './common.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export interface Logger {
  /** 自动附加 requestId、traceId、instanceId、role、X-CloudAlbum-Path */
  log(level: LogLevel, msg: string, fields?: Record<string, unknown>): void;
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}
export interface LoggerPort extends Adapter, Logger {
  flush(): Promise<void>;
  /** cloudwatch 档：本地文件照写（兜底），远端批量发送（LOG_CW_SHIPPER=sdk 默认；agent 为可选学习项）；
   *  远端失败只增加 dropped/backlog，不阻塞请求 */
  stats(): { written: number; dropped: number; backlog: number; lastRemoteSuccessAt?: string };
}
/** 只读侧（/api/lab/logs 使用）：file 档扫描本地文件，cloudwatch 档用 Logs Insights */
export interface LogReader {
  query(q: { from: string; to: string; filter?: string; limit: number }): Promise<{ mode: 'sync' | 'async'; rows?: unknown[]; queryId?: string }>;
}
