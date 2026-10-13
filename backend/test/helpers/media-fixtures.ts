// 测试辅助（local-media）：内存 SQLite + 迁移、L0 配置、假的 SecretsPort / LockPort / Logger、用户与相册种子数据
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import knexFactory from 'knex';
import type { Knex } from 'knex';
import type { AdapterDeps } from '../../src/adapters/types.js';
import { lazyAwsClients } from '../../src/adapters/aws/clients.js';
import { parseConfig, type AppConfig } from '../../src/config/schema.js';
import { nowIso } from '../../src/db/dialect.js';
import { migrateLatest } from '../../src/db/knex.js';
import { MIGRATION_SOURCE } from '../../src/db/migrations/index.js';
import type { Lease, LockPort } from '../../src/ports/lock.js';
import type { Logger } from '../../src/ports/logger.js';
import type { SecretName, SecretsPort } from '../../src/ports/secrets.js';
import { insertUser } from '../../src/repositories/users.js';

export function tempDir(prefix = 'cloudalbum-media-'): string {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

export async function testDb(): Promise<Knex> {
  const db = knexFactory({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
    migrations: { migrationSource: MIGRATION_SOURCE },
    pool: { min: 1, max: 1 },
  });
  await migrateLatest(db, { auditRetentionDays: 365 });
  return db;
}

export function testConfig(env: Record<string, string> = {}, dataDir = tempDir()): AppConfig {
  const parsed = parseConfig({
    CLOUDALBUM_ROLE: 'api', NODE_ENV: 'test', CLOUDALBUM_DATA_DIR: dataDir.replace(/\\/g, '/'),
    // 开发机的系统盘可能所剩不多：测试里把 507 阈值降到最低，避免与磁盘水位耦合
    STORAGE_LOCAL_MIN_FREE_PCT: '1', ...env,
  }, { checkImplemented: false });
  if (!parsed.config) throw new Error(`test config invalid: ${JSON.stringify(parsed.errors)}`);
  return parsed.config;
}

export function silentLogger(): Logger & { lines: Array<{ level: string; msg: string; fields?: Record<string, unknown> }> } {
  const lines: Array<{ level: string; msg: string; fields?: Record<string, unknown> }> = [];
  const mk = (level: string) => (msg: string, fields?: Record<string, unknown>) => {
    lines.push({ level, msg, ...(fields ? { fields } : {}) });
  };
  const l = {
    lines,
    log: (level: string, msg: string, fields?: Record<string, unknown>) => mk(level)(msg, fields),
    debug: mk('debug'), info: mk('info'), warn: mk('warn'), error: mk('error'),
    child: () => l,
  };
  return l as Logger & { lines: typeof lines };
}

export function fakeSecrets(values: Partial<Record<SecretName, string>> = {}): SecretsPort {
  const get = async (name: SecretName) => values[name] ?? `test-secret-${name}`;
  return {
    meta: { module: 'secrets', driver: 'env', awsService: null, authoritative: true },
    probe: async () => ({ status: 'ok', detail: 'fake' }),
    get,
    describe: async () => ({ source: 'env', origin: 'instance' }),
    onRotate: () => () => undefined,
  };
}

export function memoryLock(): LockPort & { held: Set<string> } {
  const held = new Set<string>();
  return {
    driver: 'file', scope: 'host', held,
    async tryAcquire(name: string): Promise<Lease | null> {
      if (held.has(name)) return null;
      held.add(name);
      return { name, release: async () => { held.delete(name); } };
    },
  };
}

export function adapterDeps(cfg: AppConfig, extra: Partial<AdapterDeps> = {}): AdapterDeps {
  return {
    cfg, env: {}, role: 'api', aws: lazyAwsClients({ region: cfg.core.AWS_REGION, credentials: null }),
    secrets: fakeSecrets(), logger: silentLogger(), ...extra,
  };
}

export async function seedUser(db: Knex, opts: { email?: string; role?: 'admin' | 'member'; name?: string } = {}): Promise<string> {
  const u = await insertUser(db, {
    email: opts.email ?? `${randomUUID().slice(0, 8)}@example.com`, displayName: opts.name ?? 'Tester', passwordHash: null,
    role: opts.role ?? 'member', emailVerified: true,
  });
  return u.id;
}

export async function seedAlbum(db: Knex, ownerId: string, opts: { visibility?: 'public' | 'private'; isDefault?: boolean } = {}): Promise<string> {
  const id = randomUUID();
  const now = nowIso();
  await db('albums').insert({
    id, owner_id: ownerId, title: 'Album', description: null, visibility: opts.visibility ?? 'private', cover_photo_id: null,
    is_default: opts.isDefault ?? true, created_at: now, updated_at: now,
  });
  return id;
}

/** 等待条件成立（轮询） */
export async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs = 5000, stepMs = 20): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error('waitFor: timeout');
    await new Promise((r) => setTimeout(r, stepMs));
  }
}
