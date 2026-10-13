// backend/src/adapters/lock/file.ts —— 内部 LockPort 的 `file` 实现（scope=host）
// LOCK_FILE_DIR（默认 /run/cloudalbum，systemd RuntimeDirectory）下的 flock / O_EXCL 锁文件；只在本机互斥（scope=host）
// 脚手架桩：tryAcquire 抛出 NotImplementedError。由「L0 本地实现者」填充。
import type { Lease, LockPort } from '../../ports/lock.js';
import { notImplemented } from '../../errors.js';
import type { AdapterDeps } from '../types.js';

export class FileLock implements LockPort {
  readonly driver = 'file' as const;
  readonly scope = 'host' as const;

  constructor(protected readonly deps: AdapterDeps) {}

  async tryAcquire(_name: string, _ttlSec: number): Promise<Lease | null> {
    throw notImplemented('FileLock', 'tryAcquire');
  }
}
