// backend/src/repositories/users.ts —— users 与 auth_tokens 表（F1–F4、F12）
//
// - users.id 是内部 UUID，与身份提供方解耦；local 模式下 auth_subject = users.id；cognito 模式下 auth_subject = Cognito sub。
// - auth_tokens 只存令牌的 sha256（验证码、重置链接、刷新令牌、MFA 挑战）；同一族（family）的刷新令牌被重放时整族作废。
import { randomUUID } from 'node:crypto';
import type { Knex } from 'knex';
import { boolIn, countOf, nowIso, toIso } from '../db/dialect.js';

type Db = Knex | Knex.Transaction;

export interface UserRow {
  id: string;
  email: string;
  display_name: string;
  password_hash: string | null;
  email_verified: boolean | number;
  role: 'admin' | 'member';
  plan: string;
  auth_provider: 'local' | 'cognito';
  auth_subject: string;
  token_version: number;
  created_at: string;
  updated_at: string;
  identity_id?: string | null;
  mfa_secret_enc?: string | null;
  mfa_enabled?: boolean | number;
  failed_logins?: number;
  locked_until?: string | null;
  email_status?: string;
  disabled?: boolean | number;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function findUserByEmail(db: Db, email: string): Promise<UserRow | undefined> {
  return (await db('users').where({ email: normalizeEmail(email) }).first()) as UserRow | undefined;
}

export async function findUserById(db: Db, id: string): Promise<UserRow | undefined> {
  return (await db('users').where({ id }).first()) as UserRow | undefined;
}

export async function findUserBySubject(db: Db, provider: 'local' | 'cognito', subject: string): Promise<UserRow | undefined> {
  return (await db('users').where({ auth_provider: provider, auth_subject: subject }).first()) as UserRow | undefined;
}

export async function countAdmins(db: Db): Promise<number> {
  return countOf(await db('users').where({ role: 'admin' }).count({ count: '*' }).first());
}

export async function countUsers(db: Db, filter: { provider?: 'local' | 'cognito' } = {}): Promise<number> {
  const q = db('users');
  if (filter.provider) q.where({ auth_provider: filter.provider });
  return countOf(await q.count({ count: '*' }).first());
}

/**
 * 新建用户（不含默认相册等业务副作用；注册流程在 auth 适配器 / user-directory 中用事务一并写默认相册）。
 * local 模式下 auth_subject = users.id（02#auth 第 1 节）。
 */
export async function insertUser(db: Db, input: {
  email: string; displayName: string; passwordHash: string | null; role?: 'admin' | 'member';
  emailVerified?: boolean; plan?: string; authProvider?: 'local' | 'cognito'; authSubject?: string; id?: string;
}): Promise<UserRow> {
  const id = input.id ?? randomUUID();
  const now = nowIso();
  const row = {
    id,
    email: normalizeEmail(input.email),
    display_name: input.displayName,
    password_hash: input.passwordHash,
    email_verified: input.emailVerified ?? false,
    role: input.role ?? 'member',
    plan: input.plan ?? 'free',
    auth_provider: input.authProvider ?? 'local',
    auth_subject: input.authSubject ?? id,
    token_version: 0,
    created_at: now,
    updated_at: now,
  };
  await db('users').insert(row);
  return row;
}

export type UserPatch = Partial<{
  display_name: string; password_hash: string | null; email_verified: boolean; role: 'admin' | 'member'; plan: string;
  auth_provider: 'local' | 'cognito'; auth_subject: string; identity_id: string | null; mfa_secret_enc: string | null;
  mfa_enabled: boolean; failed_logins: number; locked_until: string | null; email_status: string; disabled: boolean;
}>;

export async function updateUser(db: Db, id: string, patch: UserPatch): Promise<number> {
  return db('users').where({ id }).update({ ...patch, updated_at: nowIso() });
}

/** token_version + 1（登出、重置密码、禁用后旧 access token 立即失效），返回新版本号 */
export async function bumpTokenVersion(db: Db, id: string): Promise<number> {
  await db('users').where({ id }).update({ token_version: db.raw('token_version + 1'), updated_at: nowIso() });
  const row = (await db('users').where({ id }).first('token_version')) as { token_version?: number } | undefined;
  return Number(row?.token_version ?? 0);
}

/** 登录失败计数；达到阈值时锁定 lockMinutes 分钟。返回当前计数与锁定截止时间 */
export async function recordLoginFailure(db: Db, id: string, threshold: number, lockMinutes: number): Promise<{ failed: number; lockedUntil: string | null }> {
  await db('users').where({ id }).update({ failed_logins: db.raw('failed_logins + 1'), updated_at: nowIso() });
  const row = (await db('users').where({ id }).first('failed_logins', 'locked_until')) as { failed_logins?: number; locked_until?: string | null } | undefined;
  const failed = Number(row?.failed_logins ?? 0);
  if (failed >= threshold) {
    const lockedUntil = new Date(Date.now() + lockMinutes * 60_000).toISOString();
    await db('users').where({ id }).update({ locked_until: lockedUntil, failed_logins: 0, updated_at: nowIso() });
    return { failed, lockedUntil };
  }
  return { failed, lockedUntil: toIso(row?.locked_until) };
}

export async function resetLoginFailures(db: Db, id: string): Promise<void> {
  await db('users').where({ id }).update({ failed_logins: 0, locked_until: null, updated_at: nowIso() });
}

export async function listAdmins(db: Db): Promise<UserRow[]> {
  return (await db('users').where({ role: 'admin' }).andWhere({ disabled: false }).orderBy('created_at')) as UserRow[];
}

export interface UserListFilter { q?: string; role?: 'admin' | 'member'; provider?: 'local' | 'cognito'; limit?: number; cursor?: string }

/** 管理后台用户列表：按 created_at 倒序，游标为最后一行的 `created_at|id` */
export async function listUsers(db: Db, f: UserListFilter = {}): Promise<{ items: UserRow[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(f.limit ?? 50, 1), 200);
  const q = db('users').select('*');
  if (f.q) {
    const like = `%${f.q.trim().toLowerCase()}%`;
    q.where((w) => w.whereRaw('lower(email) like ?', [like]).orWhereRaw('lower(display_name) like ?', [like]));
  }
  if (f.role) q.where({ role: f.role });
  if (f.provider) q.where({ auth_provider: f.provider });
  const cur = decodeCursor(f.cursor);
  if (cur) q.where((w) => w.where('created_at', '<', cur.ts).orWhere((w2) => w2.where('created_at', '=', cur.ts).andWhere('id', '<', cur.id)));
  const rows = (await q.orderBy([{ column: 'created_at', order: 'desc' }, { column: 'id', order: 'desc' }]).limit(limit + 1)) as UserRow[];
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return { items, nextCursor: rows.length > limit && last ? encodeCursor(last.created_at, last.id) : null };
}

/** 迁移导出：按 id 升序分页 */
export async function listUsersAfter(db: Db, opts: { afterId?: string; limit: number; provider?: 'local' | 'cognito' }): Promise<UserRow[]> {
  const q = db('users').select('*').orderBy('id').limit(opts.limit);
  if (opts.afterId) q.where('id', '>', opts.afterId);
  if (opts.provider) q.where({ auth_provider: opts.provider });
  return (await q) as UserRow[];
}

export async function photoCountsByOwner(db: Db, ownerIds: string[]): Promise<Record<string, number>> {
  if (!ownerIds.length) return {};
  const rows = (await db('photos').whereIn('owner_id', ownerIds).groupBy('owner_id').select('owner_id').count({ count: '*' })) as Array<{ owner_id: string; count: unknown }>;
  return Object.fromEntries(rows.map((r) => [r.owner_id, Number(r.count ?? 0)]));
}

export function userIsVerified(u: Pick<UserRow, 'email_verified'>): boolean {
  return boolIn(u.email_verified);
}

// ------------------------------------------------------------------------------------------------
// auth_tokens
// ------------------------------------------------------------------------------------------------

export type AuthTokenType = 'verify_email' | 'reset_password' | 'refresh' | 'mfa_challenge';

export interface AuthTokenRow {
  id: string;
  user_id: string;
  type: AuthTokenType;
  token_hash: string;
  family_id: string | null;
  expires_at: string;
  used_at: string | null;
  created_at: string;
}

export async function insertAuthToken(db: Db, input: { userId: string; type: AuthTokenType; tokenHash: string; familyId?: string | null; expiresAt: string }): Promise<AuthTokenRow> {
  const row: AuthTokenRow = {
    id: randomUUID(), user_id: input.userId, type: input.type, token_hash: input.tokenHash, family_id: input.familyId ?? null,
    expires_at: input.expiresAt, used_at: null, created_at: nowIso(),
  };
  await db('auth_tokens').insert(row);
  return row;
}

export async function findAuthTokenByHash(db: Db, tokenHash: string, type?: AuthTokenType): Promise<AuthTokenRow | undefined> {
  const q = db('auth_tokens').where({ token_hash: tokenHash });
  if (type) q.andWhere({ type });
  return (await q.first()) as AuthTokenRow | undefined;
}

/** 原子地把令牌标记为已使用；返回 false 表示它已经被用过（并发重放） */
export async function markAuthTokenUsed(db: Db, id: string): Promise<boolean> {
  const n = await db('auth_tokens').where({ id }).whereNull('used_at').update({ used_at: nowIso() });
  return Number(n) === 1;
}

export async function deleteAuthTokens(db: Db, f: { userId?: string; type?: AuthTokenType; familyId?: string }): Promise<number> {
  if (!f.userId && !f.familyId) throw new Error('deleteAuthTokens 需要 userId 或 familyId');
  const q = db('auth_tokens');
  if (f.userId) q.where({ user_id: f.userId });
  if (f.familyId) q.where({ family_id: f.familyId });
  if (f.type) q.where({ type: f.type });
  return Number(await q.del());
}

export async function deleteExpiredAuthTokens(db: Db, before: string = nowIso()): Promise<number> {
  return Number(await db('auth_tokens').where('expires_at', '<', before).del());
}

// ------------------------------------------------------------------------------------------------
// 游标（created_at|id，base64url）
// ------------------------------------------------------------------------------------------------

export function encodeCursor(ts: string, id: string | number): string {
  return Buffer.from(`${ts}|${id}`, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string | undefined | null): { ts: string; id: string } | null {
  if (!cursor) return null;
  try {
    const s = Buffer.from(cursor, 'base64url').toString('utf8');
    const i = s.lastIndexOf('|');
    if (i <= 0) return null;
    return { ts: s.slice(0, i), id: s.slice(i + 1) };
  } catch {
    return null;
  }
}
