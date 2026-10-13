// backend/src/adapters/lock/file.ts —— 内部 LockPort 的 `file` 实现（scope=host）
//
// LOCK_FILE_DIR（默认 /run/cloudalbum，systemd RuntimeDirectory=cloudalbum）下以 O_EXCL 创建 `<name>.lock`：
// 文件内容记录持有者（pid、主机、到期时间）。只在本机互斥（scope=host）——ASG 多实例下 cron 单例必须换成 pg / redis 锁（ASG-006）。
// 过期（超过 ttl）或持有进程已不存在的锁视为陈旧，删除后重试一次。目录不可创建时（开发机没有 /run）退回系统临时目录并告警。
import { mkdirSync, openSync, readFileSync, rmSync, writeSync, closeSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import type { Lease, LockPort } from '../../ports/lock.js';
import type { AdapterDeps } from '../types.js';

interface LockContent { pid: number; host: string; token: string; acquiredAt: string; expiresAt: string }

function safeName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'lock';
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export class FileLock implements LockPort {
  readonly driver = 'file' as const;
  readonly scope = 'host' as const;
  private dir: string | undefined;

  constructor(protected readonly deps: AdapterDeps) {}

  /** 实际使用的锁目录（第一次 tryAcquire 时确定） */
  lockDir(): string {
    if (this.dir) return this.dir;
    const preferred = this.deps.cfg.core.LOCK_FILE_DIR;
    try {
      mkdirSync(preferred, { recursive: true });
      this.dir = preferred;
    } catch (e) {
      const fallback = path.join(tmpdir(), 'cloudalbum-locks');
      mkdirSync(fallback, { recursive: true });
      this.deps.logger?.warn('LOCK_FILE_DIR 不可用，文件锁改用系统临时目录', { preferred, fallback, error: (e as Error).message });
      this.dir = fallback;
    }
    return this.dir;
  }

  private read(file: string): LockContent | null {
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as LockContent;
    } catch {
      return null;
    }
  }

  private isStale(c: LockContent | null): boolean {
    if (!c) return true;                                   // 内容损坏（例如写到一半进程崩溃）
    if (Date.parse(c.expiresAt) <= Date.now()) return true;
    return c.host === hostname() && !processAlive(c.pid);
  }

  async tryAcquire(name: string, ttlSec: number): Promise<Lease | null> {
    const file = path.join(this.lockDir(), `${safeName(name)}.lock`);
    const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const fd = openSync(file, 'wx', 0o640);
        try {
          const now = Date.now();
          const content: LockContent = {
            pid: process.pid, host: hostname(), token,
            acquiredAt: new Date(now).toISOString(), expiresAt: new Date(now + Math.max(1, ttlSec) * 1000).toISOString(),
          };
          writeSync(fd, JSON.stringify(content));
        } finally {
          closeSync(fd);
        }
        let released = false;
        return {
          name,
          release: async () => {
            if (released) return;
            released = true;
            const cur = this.read(file);
            if (cur?.token === token) rmSync(file, { force: true });
          },
        };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        if (attempt === 0 && this.isStale(this.read(file))) {
          rmSync(file, { force: true });
          continue;
        }
        return null;
      }
    }
    return null;
  }
}
