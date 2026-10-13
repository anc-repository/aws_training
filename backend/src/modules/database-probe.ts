// backend/src/modules/database-probe.ts —— database 模块的探针（总纲 4.3：database 不设端口；03#database 第 10 节）
//
// 常规：经连接池 `select 1`（主库与 dbRead）；服务器版本；主机分类（*.proxy-*.rds.amazonaws.com → RDS Proxy；
//   *.rds.amazonaws.com → rds；回环地址 → 自建或本机 PgBouncer；文件 → SQLite）；连接池排队。
//   degraded：延迟 > 200ms；连接池有排队；只读副本存在但不可达（detail 标注）。error：主库连接失败。
// SQLite（localHealth）：文件可写；数据卷剩余 < 15% → degraded；深度探针执行 PRAGMA quick_check。
// 深度（管理员或 enable 健康检查阶段，主机为 RDS）：rds:DescribeDBInstances（状态、Multi-AZ、待处理修改、LatestRestorableTime、
//   只读副本状态），经 adapters/aws/clients.ts 的 describeDbInstance()（modules/ 下不能直接引用 @aws-sdk）。
//   无凭证时跳过，detail 写“无凭证：控制面感知不可用”（CRED-004）；控制面确认实例不存在 → error。
import { accessSync, constants as fsConstants, existsSync, statfsSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import type { Knex } from 'knex';
import { describeAwsError, describeDbInstance, type AwsClients, type DbInstanceSummary } from '../adapters/aws/clients.js';
import type { AppConfig } from '../config/schema.js';
import { hostOf } from '../config/net.js';
import { checkPgCa, databaseHostClass, pgTlsMode } from '../db/knex.js';
import type { ProbeResult } from '../ports/common.js';

export interface DatabaseProbeOptions {
  deep?: boolean;
  dbRead?: Knex;
  /** 深度探针的控制面查询（container 传入 c.aws；没有时跳过） */
  aws?: AwsClients;
}

const round1 = (ms: number) => Math.round(ms * 10) / 10;

/** RDS 端点的第一个标签就是 DB 实例标识符：cloudalbum-lab-database.xxxx.ap-northeast-1.rds.amazonaws.com */
export function rdsInstanceIdOf(host: string | undefined): string | null {
  const h = hostOf(host ?? '');
  if (!/\.rds\.amazonaws\.com(\.cn)?$/i.test(h) || /\.proxy-[a-z0-9]+\./i.test(h)) return null;
  return h.split('.')[0] || null;
}

function poolPending(db: Knex): number {
  try {
    const pool = (db.client as { pool?: { numPendingAcquires?: () => number } }).pool;
    return typeof pool?.numPendingAcquires === 'function' ? pool.numPendingAcquires() : 0;
  } catch {
    return 0;
  }
}

async function selectOne(db: Knex): Promise<number> {
  const t0 = performance.now();
  await db.raw('select 1');
  return round1(performance.now() - t0);
}

export async function databaseProbe(db: Knex, cfg: AppConfig, opts: DatabaseProbeOptions = {}): Promise<ProbeResult> {
  let latencyMs: number;
  try {
    latencyMs = await selectOne(db);
  } catch (e) {
    return { status: 'error', detail: `数据库连接失败：${(e as Error).message}`, confidence: 'confirmed', data: { hostClass: databaseHostClass(cfg.db) } };
  }
  const hostClass = databaseHostClass(cfg.db);
  const problems: string[] = [];
  let status: ProbeResult['status'] = latencyMs > 200 ? 'degraded' : 'ok';
  if (latencyMs > 200) problems.push(`select 1 = ${latencyMs}ms > 200ms`);
  const data: Record<string, unknown> = { hostClass };

  if (cfg.db.DB_DRIVER === 'sqlite') {
    let version = '?';
    try {
      const r = (await db.raw('select sqlite_version() as v')) as Array<{ v: string }>;
      version = r[0]?.v ?? '?';
    } catch {
      /* 忽略 */
    }
    const file = cfg.db.SQLITE_PATH;
    Object.assign(data, { version: `SQLite ${version}`, file });
    if (file !== ':memory:' && existsSync(file)) {
      try {
        accessSync(file, fsConstants.W_OK);
      } catch {
        return { status: 'error', detail: `SQLite 文件不可写：${file}`, latencyMs, confidence: 'confirmed', data };
      }
      try {
        const s = statfsSync(path.dirname(file));
        const free = s.blocks > 0 ? s.bavail / s.blocks : 1;
        data.volumeFreePct = Math.round(free * 100);
        if (free < 0.15) {
          status = 'degraded';
          problems.push(`数据卷剩余 ${Math.round(free * 100)}% < 15%`);
        }
      } catch {
        /* 忽略 */
      }
    }
    if (opts.deep) {
      try {
        const r = (await db.raw('PRAGMA quick_check')) as Array<Record<string, string>>;
        const result = Object.values(r[0] ?? {})[0] ?? '?';
        data.quickCheck = result;
        if (result !== 'ok') return { status: 'error', detail: `PRAGMA quick_check 失败：${result}`, latencyMs, confidence: 'confirmed', data };
      } catch (e) {
        return { status: 'error', detail: `PRAGMA quick_check 失败：${(e as Error).message}`, latencyMs, confidence: 'confirmed', data };
      }
    }
    return {
      status,
      detail: `select 1 = ${latencyMs}ms · SQLite ${version} · 主机分类：file${opts.deep ? ' · quick_check ok' : ''}${problems.length ? ` · ${problems.join('；')}` : ''}`,
      latencyMs, confidence: 'confirmed', data,
    };
  }

  // —— PostgreSQL ——
  const pg = cfg.db;
  let version = '?';
  try {
    const r = (await db.raw('show server_version')) as { rows?: Array<{ server_version: string }> };
    version = r.rows?.[0]?.server_version ?? '?';
  } catch {
    /* 忽略 */
  }
  Object.assign(data, { version: `PostgreSQL ${version}`, host: pg.DB_HOST, ...(pg.DB_READ_HOST ? { readHost: pg.DB_READ_HOST } : {}) });
  const pending = poolPending(db);
  if (pending > 0) {
    status = 'degraded';
    problems.push(`连接池有 ${pending} 个请求在排队（DB_POOL_MAX=${pg.DB_POOL_MAX}）`);
  }
  data.poolPending = pending;

  // TLS：CA 证书包在启动后丢失 / 不可读 → error（下一次重启会以 78 拒绝启动）；显式 no-verify 连接非回环地址 → degraded
  const tls = pgTlsMode(pg);
  data.tls = tls;
  if (tls === 'verify-ca') {
    const ca = checkPgCa(pg);
    if (ca.error) {
      return { status: 'error', detail: `DB_SSL_CA ${ca.error}：无法校验数据库证书（重启后将拒绝启动，CFG-001）`, latencyMs, confidence: 'confirmed', data };
    }
  } else if (tls === 'no-verify' && hostClass !== 'local' && hostClass !== 'pgbouncer') {
    status = 'degraded';
    problems.push('DB_SSL=no-verify：TLS 不校验服务器证书（可被中间人攻击），请配置 DB_SSL_CA 并改回 require');
  } else if (tls === 'disable' && (hostClass === 'rds' || hostClass === 'rds-proxy' || hostClass === 'remote')) {
    status = 'degraded';
    problems.push('DB_SSL=disable：到远程数据库的连接未加密');
  }

  let replicaText = pg.DB_READ_HOST ? '有只读副本' : '无只读副本';
  if (opts.dbRead && opts.dbRead !== db) {
    try {
      const ms = await selectOne(opts.dbRead);
      data.replicaLatencyMs = ms;
      replicaText += ` · 副本 select 1 = ${ms}ms`;
    } catch (e) {
      status = 'degraded';
      problems.push(`只读副本不可达（读请求请改走主库）：${(e as Error).message}`);
    }
  }

  let deepText = '';
  if (opts.deep && hostClass === 'rds') {
    const deep = await rdsDeepProbe(cfg, opts.aws);
    Object.assign(data, deep.data);
    deepText = deep.detail ? ` · ${deep.detail}` : '';
    if (deep.status === 'error') status = 'error';
    else if (deep.status === 'degraded' && status === 'ok') status = 'degraded';
  }
  return {
    status,
    detail: `select 1 = ${latencyMs}ms · PostgreSQL ${version} · 主机分类：${hostClass} · ${replicaText} · TLS ${tls}${deepText}${problems.length ? ` · ${problems.join('；')}` : ''}`,
    latencyMs,
    confidence: 'confirmed',
    data,
  };
}

function summarize(i: DbInstanceSummary): string {
  return `${i.id} ${i.status} · Multi-AZ ${i.multiAz ? '开' : '关'}${i.latestRestorableTime ? ` · 最近可恢复时间点 ${i.latestRestorableTime}` : ''}`;
}

async function rdsDeepProbe(cfg: AppConfig, aws: AwsClients | undefined): Promise<{ status: ProbeResult['status']; detail: string; data: Record<string, unknown> }> {
  if (cfg.db.DB_DRIVER !== 'postgres') return { status: 'ok', detail: '', data: {} };
  if (!aws?.enabled) return { status: 'ok', detail: '无凭证：控制面感知不可用（CRED-004）', data: {} };
  const primaryId = rdsInstanceIdOf(cfg.db.DB_HOST);
  if (!primaryId) return { status: 'ok', detail: '', data: {} };
  try {
    const primary = await describeDbInstance(aws, primaryId);
    if (!primary) return { status: 'error', detail: `控制面确认 DB 实例 ${primaryId} 不存在`, data: { dbInstanceId: primaryId } };
    const data: Record<string, unknown> = { rds: primary };
    let status: ProbeResult['status'] = primary.status === 'available' ? 'ok' : 'degraded';
    const notes = [summarize(primary)];
    if (primary.pendingModified.length) {
      status = 'degraded';
      notes.push(`待处理修改：${primary.pendingModified.join(', ')}`);
    }
    const replicaId = rdsInstanceIdOf(cfg.db.DB_READ_HOST);
    if (replicaId) {
      const replica = await describeDbInstance(aws, replicaId);
      data.rdsReplica = replica;
      if (!replica) {
        status = 'degraded';
        notes.push(`只读副本 ${replicaId} 不存在`);
      } else {
        notes.push(`副本 ${replica.id} ${replica.status}`);
        if (replica.status !== 'available') status = 'degraded';
      }
    }
    return { status, detail: notes.join(' · '), data };
  } catch (e) {
    return { status: 'degraded', detail: `DescribeDBInstances 失败：${describeAwsError(e)}`, data: {} };
  }
}
