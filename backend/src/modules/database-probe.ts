// backend/src/modules/database-probe.ts —— database 模块的探针（总纲 4.3：database 不设端口）
//
// select 1 延迟、服务器版本、主机分类（*.proxy-*.rds.amazonaws.com → RDS Proxy；*.rds.amazonaws.com → RDS；
// 回环地址 → 自建或本机 PgBouncer；文件 → SQLite）。管理员深度探针再调用 rds:DescribeDBInstances（Multi-AZ、状态、
// 待处理维护、副本延迟）——由「database 模块实现者」经 adapters/aws/clients.ts 的 rds() 客户端补上（opts.deep）。
import { performance } from 'node:perf_hooks';
import type { Knex } from 'knex';
import type { AppConfig } from '../config/schema.js';
import { databaseHostClass } from '../db/knex.js';
import type { ProbeResult } from '../ports/common.js';

export async function databaseProbe(db: Knex, cfg: AppConfig, opts: { deep?: boolean; dbRead?: Knex } = {}): Promise<ProbeResult> {
  const t0 = performance.now();
  try {
    await db.raw('select 1');
    const latencyMs = Math.round((performance.now() - t0) * 10) / 10;
    let version = '';
    if (cfg.db.DB_DRIVER === 'sqlite') {
      const r = (await db.raw('select sqlite_version() as v')) as Array<{ v: string }>;
      version = `SQLite ${r[0]?.v ?? '?'}`;
    } else {
      const r = (await db.raw('show server_version')) as { rows?: Array<{ server_version: string }> };
      version = `PostgreSQL ${r.rows?.[0]?.server_version ?? '?'}`;
    }
    const hostClass = databaseHostClass(cfg.db);
    const replica = cfg.db.DB_DRIVER === 'postgres' && cfg.db.DB_READ_HOST ? '有只读副本' : '无只读副本';
    let replicaDetail = '';
    if (opts.dbRead && opts.dbRead !== db) {
      const r0 = performance.now();
      await opts.dbRead.raw('select 1');
      replicaDetail = ` · 副本 select 1 = ${Math.round((performance.now() - r0) * 10) / 10}ms`;
    }
    return {
      status: latencyMs > 200 ? 'degraded' : 'ok',
      detail: `select 1 = ${latencyMs}ms · ${version} · 主机分类：${hostClass} · ${replica}${replicaDetail}`,
      latencyMs,
      confidence: 'confirmed',
      data: { hostClass, version, ...(cfg.db.DB_DRIVER === 'sqlite' ? { file: cfg.db.SQLITE_PATH } : { host: cfg.db.DB_HOST }) },
    };
  } catch (e) {
    return { status: 'error', detail: `数据库连接失败：${(e as Error).message}`, confidence: 'confirmed' };
  }
}
