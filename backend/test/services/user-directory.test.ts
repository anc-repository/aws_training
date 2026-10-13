// UserDirectory：Principal → users.id（local 直接用 subject；cognito 首个请求 JIT 建档 / 按邮箱绑定）
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import knexFactory from 'knex';
import type { Knex } from 'knex';
import { MIGRATION_SOURCE } from '../../src/db/migrations/index.js';
import { migrateLatest } from '../../src/db/knex.js';
import type { Principal } from '../../src/ports/auth.js';
import { createUserWithDefaults, toAdminUser, toMe, UserDirectory } from '../../src/services/user-directory.js';

let db: Knex;

beforeAll(async () => {
  db = knexFactory({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true,
    migrations: { migrationSource: MIGRATION_SOURCE }, pool: { min: 1, max: 1 } });
  await migrateLatest(db);
});

afterAll(async () => {
  await db?.destroy();
});

const cognito = (sub: string, email: string, groups: string[] = []): Principal => ({
  provider: 'cognito', subject: sub, email, emailVerified: true, groups, plan: 'free', expiresAt: Math.floor(Date.now() / 1000) + 900,
});

describe('UserDirectory', () => {
  it('local：subject 就是 users.id', async () => {
    const u = await createUserWithDefaults(db, { email: 'loc@example.com', displayName: 'loc', passwordHash: null });
    const dir = new UserDirectory(db);
    expect(await dir.userIdOf({ ...cognito(u.id, u.email), provider: 'local' })).toBe(u.id);
  });

  it('cognito：首次请求新建用户 + 默认相册；再次请求命中缓存；admin 组映射为 role=admin', async () => {
    const dir = new UserDirectory(db);
    const u = await dir.ensureUser(cognito('sub-new', 'New@Example.com', ['admin']));
    expect(u).toMatchObject({ email: 'new@example.com', auth_provider: 'cognito', auth_subject: 'sub-new', role: 'admin', password_hash: null });
    expect(await db('albums').where({ owner_id: u.id, is_default: true }).first()).toBeTruthy();
    expect(await dir.userIdOf(cognito('sub-new', 'new@example.com'))).toBe(u.id);
  });

  it('cognito：已有同邮箱的本地用户 → 绑定（迁移后保持 users.id 不变）', async () => {
    const local = await createUserWithDefaults(db, { email: 'migrated@example.com', displayName: 'm', passwordHash: 'argon' });
    const u = await new UserDirectory(db).ensureUser(cognito('sub-migrated', 'migrated@example.com'));
    expect(u.id).toBe(local.id);
    expect(u).toMatchObject({ auth_provider: 'cognito', auth_subject: 'sub-migrated' });
  });

  it('cognito：令牌里没有 email 时用占位地址建档', async () => {
    const u = await new UserDirectory(db).ensureUser(cognito('sub-noemail', ''));
    expect(u.email).toBe('sub-noemail@cognito.invalid');
  });

  it('toMe / toAdminUser 的对外形状', async () => {
    const u = await createUserWithDefaults(db, { email: 'view@example.com', displayName: 'View', passwordHash: null, emailVerified: false });
    expect(toMe(u)).toMatchObject({ id: u.id, email: 'view@example.com', displayName: 'View', emailVerified: false, restricted: true, groups: ['member'],
      provider: 'local', mfaEnabled: false });
    expect(toAdminUser(u, 3)).toMatchObject({ disabled: false, lockedUntil: null, photoCount: 3, failedLogins: 0 });
  });
});
