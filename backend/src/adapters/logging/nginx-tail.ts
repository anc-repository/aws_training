// backend/src/adapters/logging/nginx-tail.ts —— Nginx 访问日志的增量读取与转发（05#logging 第 2 节）
//
// cloudwatch 档（LOG_CW_SHIPPER=sdk）下，worker 进程增量读取 LOG_DIR/nginx-access.json（总纲 2.5 的 cloudalbum_json 格式，
// logrotate `create 0640 nginx cloudalbum`，worker 以 cloudalbum 组可读），把新行转发到 /cloudalbum/<env>/nginx 的
// `{instanceId}/access` 日志流。
//   - 启动时从文件末尾开始（不回填历史；历史仍在本地文件里，见第 6 节“历史日志”）；
//   - 轮转：inode 变化时先把旧文件（已改名为 .1）剩余的部分读完，再从新文件开头读；文件变短（被截断）时从头读；
//   - 事件时间取日志行的 `ts`（$time_iso8601，秒级精度），解析失败时用读取时刻——ingestionTime − timestamp 因此是
//     “请求完成 → CloudWatch 收下”的端到端延迟（ingest-lag 实验的服务端证据，精度 1 秒）；
//   - 每次最多读 1 MiB，不完整的最后一行留到下一轮。
// 这是 logging 模块自带的读取器（不改 worker 的源站卸载统计）；两者读同一个文件、互不影响。
import { closeSync, openSync, readSync, statSync } from 'node:fs';

const MAX_READ_BYTES = 1024 * 1024;

export interface TailSink {
  enqueue(message: string, timestamp?: number): void;
}

export interface TailOptions {
  file: string;
  sink: TailSink;
  intervalMs?: number;
  now?: () => number;
  /** 测试：从文件开头读（缺省从末尾开始） */
  fromStart?: boolean;
}

/** 日志行的事件时间：`"ts":"2026-10-14T10:00:00+09:00"`；没有或解析失败时返回 undefined */
export function lineTimestamp(line: string): number | undefined {
  const m = /"ts":"([^"]{10,40})"/.exec(line);
  if (!m) return undefined;
  const t = Date.parse(m[1]!);
  return Number.isFinite(t) ? t : undefined;
}

export class NginxAccessTailer {
  private ino: number | undefined;
  private offset = 0;
  private partial = '';
  private timer: NodeJS.Timeout | undefined;
  private started = false;
  private readonly now: () => number;
  lines = 0;
  lastReadAt: number | undefined;
  lastError: string | undefined;

  constructor(private readonly opts: TailOptions) {
    this.now = opts.now ?? (() => Date.now());
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    const st = this.stat(this.opts.file);
    if (st) {
      this.ino = st.ino;
      this.offset = this.opts.fromStart ? 0 : st.size;
    }
    this.timer = setInterval(() => this.poll(), this.opts.intervalMs ?? 1000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.started = false;
  }

  private stat(file: string): { ino: number; size: number } | undefined {
    try {
      const s = statSync(file);
      return { ino: s.ino, size: s.size };
    } catch {
      return undefined;
    }
  }

  /** 一轮读取（定时器调用；测试可直接调用） */
  poll(): void {
    try {
      const st = this.stat(this.opts.file);
      if (!st) return;
      if (this.ino === undefined) {
        this.ino = st.ino;
        this.offset = 0;
      } else if (st.ino !== this.ino) {
        // 轮转：旧文件改名为 .1，先把它剩下的部分读完（找不到就放弃这一小段）
        const rotated = this.stat(`${this.opts.file}.1`);
        if (rotated && rotated.ino === this.ino) this.readRange(`${this.opts.file}.1`, rotated.size);
        this.flushPartial();
        this.ino = st.ino;
        this.offset = 0;
      } else if (st.size < this.offset) {
        this.flushPartial();
        this.offset = 0;                     // copytruncate 或手工清空
      }
      if (st.size > this.offset) this.readRange(this.opts.file, st.size);
    } catch (e) {
      this.lastError = (e as Error).message;
    }
  }

  private readRange(file: string, size: number): void {
    const len = Math.min(size - this.offset, MAX_READ_BYTES);
    if (len <= 0) return;
    const fd = openSync(file, 'r');
    try {
      const buf = Buffer.alloc(len);
      const n = readSync(fd, buf, 0, len, this.offset);
      this.offset += n;
      this.lastReadAt = this.now();
      const text = this.partial + buf.subarray(0, n).toString('utf8');
      const parts = text.split('\n');
      this.partial = parts.pop() ?? '';
      for (const line of parts) this.emit(line);
    } finally {
      closeSync(fd);
    }
  }

  private flushPartial(): void {
    if (this.partial) this.emit(this.partial);
    this.partial = '';
  }

  private emit(line: string): void {
    const t = line.trim();
    if (!t) return;
    this.lines += 1;
    this.opts.sink.enqueue(t, lineTimestamp(t) ?? this.now());
  }
}
