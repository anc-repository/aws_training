// backend/src/db/knex.ts —— Knex 实例：db 与 dbRead（总纲 §4.3、§4.5）
//
// DB_DRIVER=sqlite → better-sqlite3（journal_mode=WAL，busy_timeout=5000，foreign_keys=ON）；
// DB_DRIVER=postgres → pg；DB_PROXY_MODE≠none 时连接目标换成 DB_PROXY_ENDPOINT（本机 PgBouncer 或 RDS Proxy），
// 业务代码与仓储层完全不变。database 不设端口：本文件的 instrumentKnex() 把每次查询记入 Server-Timing 的 database 项、
// X-CloudAlbum-Path 的 database 段与 LabMetricsStore。
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import knexFactory from 'knex';
import type { Knex } from 'knex';
import type { AppConfig } from '../config/schema.js';
import { isLoopback } from '../config/net.js';
import { ConfigValidationError } from '../errors.js';
import type { CallObserver } from '../observability/instrument.js';
import { currentContext } from '../observability/request-context.js';
import type { SecretsPort } from '../ports/secrets.js';
import { MIGRATION_SOURCE } from './migrations/index.js';

type Db = AppConfig['db'];
export type PostgresDb = Extract<Db, { DB_DRIVER: 'postgres' }>;

/** 主机分类（database-probe 与路径头共用）：file | local | pgbouncer | rds | rds-proxy | remote */
export function databaseHostClass(db: Db, opts: { read?: boolean } = {}): 'file' | 'local' | 'pgbouncer' | 'rds' | 'rds-proxy' | 'remote' {
  if (db.DB_DRIVER === 'sqlite') return 'file';
  const host = connectionHost(db, opts);
  if (/\.proxy-[a-z0-9]+\.[a-z0-9-]+\.rds\.amazonaws\.com$/i.test(host)) return 'rds-proxy';
  if (/\.rds\.amazonaws\.com$/i.test(host)) return 'rds';
  if (isLoopback(host)) return db.DB_PROXY_MODE === 'pgbouncer' ? 'pgbouncer' : 'local';
  return 'remote';
}

/** 路径头的 database 段值：sqlite | postgres@local | postgres@pgbouncer | postgres@rds | postgres@rds-proxy */
export function databasePathValue(db: Db, opts: { read?: boolean } = {}): string {
  if (db.DB_DRIVER === 'sqlite') return 'sqlite';
  const cls = databaseHostClass(db, opts);
  return `postgres@${cls === 'remote' ? 'remote' : cls}${opts.read ? ':replica' : ''}`;
}

function connectionHost(db: PostgresDb, opts: { read?: boolean }): string {
  if (opts.read && db.DB_READ_HOST) return db.DB_READ_HOST;
  if (db.DB_PROXY_MODE !== 'none' && db.DB_PROXY_ENDPOINT) return db.DB_PROXY_ENDPOINT;
  return db.DB_HOST;
}

/**
 * PostgreSQL 的 TLS 设置（03#database：`ssl: { ca: readFileSync(DB_SSL_CA), rejectUnauthorized: true }`）：
 * - DB_SSL=disable → 不加密；DB_SSL=no-verify → 加密但不校验证书（只能显式选择，探针在非回环地址上报 degraded）；
 * - DB_SSL=require + 配置了 CA 文件 → 校验证书；CA 文件读不到（缺失、无权限、路径写错）→ ConfigValidationError（CFG-001，退出码 78），
 *   绝不静默降级为“不校验”（那等于对中间人敞开）；
 * - DB_SSL=require + 没有配置 CA → 用 Node 内置的公共根证书校验（RDS Proxy 的 Amazon Trust Services 证书可直接通过）；
 *   唯一例外是回环地址（本机自建 PostgreSQL / PgBouncer 的自签证书）：加密但不校验。
 */
export type PgTlsMode = 'disable' | 'verify-ca' | 'verify-system' | 'no-verify' | 'loopback-unverified';

export function pgTlsCaFile(db: PostgresDb, opts: { read?: boolean } = {}): string | undefined {
  const usingProxy = db.DB_PROXY_MODE !== 'none' && Boolean(db.DB_PROXY_ENDPOINT) && !opts.read;
  return (usingProxy ? (db.DB_PROXY_SSL_CA ?? db.DB_SSL_CA) : db.DB_SSL_CA) || undefined;
}

export function pgTlsMode(db: PostgresDb, opts: { read?: boolean } = {}): PgTlsMode {
  if (db.DB_SSL === 'disable') return 'disable';
  if (db.DB_SSL === 'no-verify') return 'no-verify';
  if (pgTlsCaFile(db, opts)) return 'verify-ca';
  return isLoopback(connectionHost(db, opts)) ? 'loopback-unverified' : 'verify-system';
}

/** 读取 CA 文件；读不到时返回原因（探针用），不抛错 */
export function checkPgCa(db: PostgresDb, opts: { read?: boolean } = {}): { file?: string; ca?: string; error?: string } {
  const file = pgTlsCaFile(db, opts);
  if (!file || db.DB_SSL !== 'require') return {};
  try {
    const ca = readFileSync(file, 'utf8');
    if (!ca.includes('BEGIN CERTIFICATE')) return { file, error: `${file} 不是 PEM 证书包` };
    return { file, ca };
  } catch (e) {
    return { file, error: `${file} 不可读：${(e as NodeJS.ErrnoException).code ?? (e as Error).message}` };
  }
}

export function pgSslOptions(db: PostgresDb, opts: { read?: boolean } = {}): false | { rejectUnauthorized: boolean; ca?: string } {
  const mode = pgTlsMode(db, opts);
  switch (mode) {
    case 'disable':
      return false;
    case 'no-verify':
    case 'loopback-unverified':
      return { rejectUnauthorized: false };
    case 'verify-system':
      return { rejectUnauthorized: true };
    case 'verify-ca': {
      const r = checkPgCa(db, opts);
      if (!r.ca) {
        throw new ConfigValidationError([
          `[CFG-001] DB_SSL=require，但 CA 证书包${r.error ? ` ${r.error}` : '不可用'}。`,
          '拒绝以“加密但不校验证书”的方式连接数据库（可被中间人攻击）。',
          '修复：重新执行 scripts/module enable database（重新下载 /etc/cloudalbum/rds-ca.pem），或修正 DB_SSL_CA 的路径与权限（root:cloudalbum 0640）；',
          '确需临时跳过校验时只能显式设置 DB_SSL=no-verify（探针会报 degraded）。',
        ].join('\n'));
      }
      return { rejectUnauthorized: true, ca: r.ca };
    }
  }
}

export interface CreateKnexOptions {
  read?: boolean;
  /** 测试用：覆盖 SQLite 文件（例如 ':memory:'） */
  sqliteFilename?: string;
}

export async function createKnex(cfg: AppConfig, secrets?: SecretsPort, opts: CreateKnexOptions = {}): Promise<Knex> {
  const db = cfg.db;
  if (db.DB_DRIVER === 'sqlite') {
    const filename = opts.sqliteFilename ?? db.SQLITE_PATH;
    if (filename !== ':memory:') mkdirSync(path.dirname(filename), { recursive: true });
    return knexFactory({
      client: 'better-sqlite3',
      connection: { filename },
      useNullAsDefault: true,
      migrations: { migrationSource: MIGRATION_SOURCE, tableName: 'knex_migrations' },
      pool: {
        min: 1,
        max: 1,
        afterCreate(conn: { pragma(sql: string): unknown }, done: (err: Error | null, conn: unknown) => void) {
          try {
            conn.pragma('journal_mode = WAL');
            conn.pragma('busy_timeout = 5000');
            conn.pragma('foreign_keys = ON');
            conn.pragma('synchronous = NORMAL');
            done(null, conn);
          } catch (e) {
            done(e as Error, conn);
          }
        },
      },
    });
  }

  const usingProxy = db.DB_PROXY_MODE !== 'none' && Boolean(db.DB_PROXY_ENDPOINT) && !opts.read;
  const host = connectionHost(db, opts);
  const port = usingProxy ? db.DB_PROXY_PORT : db.DB_PORT;
  const ssl = pgSslOptions(db, opts);
  return knexFactory({
    client: 'pg',
    // 函数形式：每次建新连接时重新取密码（db-password 轮换后自然生效；IAM 认证变体由 db-proxy 实现者在这里换成签名令牌）
    connection: async () => ({
      host,
      port,
      user: db.DB_USER,
      database: db.DB_NAME,
      password: db.DB_PASSWORD ?? (secrets ? await secrets.get('db-password') : undefined),
      ssl,
      application_name: `cloudalbum-${cfg.core.CLOUDALBUM_ROLE}`,
    }),
    pool: { min: 0, max: db.DB_POOL_MAX },
    migrations: { migrationSource: MIGRATION_SOURCE, tableName: 'knex_migrations' },
  });
}

/**
 * 把每次查询记入请求上下文（Server-Timing 的 database 项累加、路径头的 database 段）与观察者（LabMetricsStore）。
 * database 没有端口，因此不经 instrument 代理（总纲 4.3）。
 */
export function instrumentKnex(db: Knex, pathValue: string, observers: readonly CallObserver[] = []): Knex {
  const started = new Map<string, number>();
  const driver = pathValue.split('@')[0]!.split(':')[0]!;
  const finish = (uid: string | undefined, ok: boolean, error?: unknown) => {
    if (!uid) return;
    const t0 = started.get(uid);
    if (t0 === undefined) return;
    started.delete(uid);
    const ms = performance.now() - t0;
    const ctx = currentContext();
    if (ctx) {
      ctx.path.markIfAbsent('database', pathValue);
      ctx.timing.add('database', ms);
    }
    for (const o of observers) {
      try {
        o.onCall({
          module: 'database', driver, method: 'query', ms, ok, ...(error !== undefined ? { error } : {}), inRequest: Boolean(ctx),
          ...(ctx?.experiment ? { runId: ctx.experiment.runId, ...(ctx.experiment.label ? { label: ctx.experiment.label } : {}) } : {}),
        });
      } catch {
        /* ignore */
      }
    }
  };
  db.on('query', (q: { __knexQueryUid?: string }) => {
    if (q.__knexQueryUid) started.set(q.__knexQueryUid, performance.now());
  });
  db.on('query-response', (_r: unknown, q: { __knexQueryUid?: string }) => finish(q.__knexQueryUid, true));
  db.on('query-error', (e: unknown, q: { __knexQueryUid?: string }) => finish(q.__knexQueryUid, false, e));
  return db;
}

export interface MigrateOptions { auditRetentionDays?: number }

/** 执行全部迁移（双方言可执行）；返回本次执行的迁移名 */
export async function migrateLatest(db: Knex, opts: MigrateOptions = {}): Promise<string[]> {
  const { setMigrationParams } = await import('./migrations/params.js');
  setMigrationParams({ auditRetentionDays: opts.auditRetentionDays ?? 365 });
  const [, log] = (await db.migrate.latest()) as [number, string[]];
  return log;
}
