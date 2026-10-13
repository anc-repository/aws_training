// backend/src/adapters/lock/pg.ts —— 内部 LockPort 的 `pg` 实现（scope=cluster）
// PostgreSQL advisory lock（pg_try_advisory_lock）；DB_DRIVER=postgres 时全集群互斥
// 脚手架桩：tryAcquire 抛出 NotImplementedError。由「database 模块实现者」填充。
import type { Lease, LockPort } from '../../ports/lock.js';
import { notImplemented } from '../../errors.js';
import type { AdapterDeps } from '../types.js';

export class PgLock implements LockPort {
  readonly driver = 'pg' as const;
  readonly scope = 'cluster' as const;

  constructor(protected readonly deps: AdapterDeps) {}

  async tryAcquire(_name: string, _ttlSec: number): Promise<Lease | null> {
    throw notImplemented('PgLock', 'tryAcquire');
  }
}
