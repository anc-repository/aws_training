// backend/src/adapters/lock/pg.ts —— 内部 LockPort 的 `pg` 实现（scope=cluster）
// PostgreSQL 会话级 advisory lock（pg_try_advisory_lock）：从 Knex 连接池借出一条专用连接，持有期间不归还；
// release() 时 pg_advisory_unlock 并归还连接。进程崩溃时会话结束、锁自动释放，所以 ttlSec 只作为“最长持有时间”的保险
// （超时自动释放，防止忘记 release 的代码永久占住一条连接）。DB_DRIVER=postgres 时全集群互斥。
import { createHash } from 'node:crypto';
import type { Knex } from 'knex';
import type { Lease, LockPort } from '../../ports/lock.js';
import type { AdapterDeps } from '../types.js';

/** 锁名 → 有符号 64 位整数（sha256 前 8 字节） */
export function advisoryKey(name: string): string {
  const h = createHash('sha256').update(`cloudalbum:${name}`).digest();
  return BigInt.asIntN(64, h.readBigUInt64BE(0)).toString();
}

interface PoolClient {
  acquireConnection(): Promise<unknown>;
  releaseConnection(conn: unknown): Promise<unknown>;
}

export class PgLock implements LockPort {
  readonly driver = 'pg' as const;
  readonly scope = 'cluster' as const;

  constructor(protected readonly deps: AdapterDeps) {}

  private db(): Knex {
    const db = this.deps.db;
    if (!db) throw new Error('PgLock：缺少依赖 db（container 装配顺序错误）');
    return db;
  }

  async tryAcquire(name: string, ttlSec: number): Promise<Lease | null> {
    const db = this.db();
    const pool = db.client as unknown as PoolClient;
    const key = advisoryKey(name);
    const conn = await pool.acquireConnection();
    let got = false;
    try {
      const r = await db.raw('select pg_try_advisory_lock(?::bigint) as locked', [key]).connection(conn);
      const row = (r as { rows?: Array<{ locked: boolean }> }).rows?.[0];
      got = Boolean(row?.locked);
    } finally {
      if (!got) await pool.releaseConnection(conn);
    }
    if (!got) return null;
    let released = false;
    const release = async () => {
      if (released) return;
      released = true;
      clearTimeout(timer);
      try {
        await db.raw('select pg_advisory_unlock(?::bigint)', [key]).connection(conn);
      } finally {
        await pool.releaseConnection(conn);
      }
    };
    const timer = setTimeout(() => { void release().catch(() => undefined); }, Math.max(1, ttlSec) * 1000);
    timer.unref();
    return { name, release };
  }
}
