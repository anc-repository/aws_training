// backend/src/services/user-directory.ts —— 用户目录：Principal → 内部用户（users.id）、注册时的默认数据（F2）、对外视图
//
// - local：Principal.subject 就是 users.id。
// - cognito：首个已认证请求时 JIT 建档（02#auth 第 2 节）：先按 (auth_provider, auth_subject) 找；找不到时按 email 绑定已有行
//   （bulk 迁移 / 回滚后再启用的情况），否则新建用户 + 默认相册。结果在进程内缓存 60 秒。
// - toMe() / toAdminUser() 生成前端使用的 JSON 形状（camelCase，见 frontend/src/api/types.ts 的 Me / AdminUser）。
import type { Knex } from 'knex';
import type { Principal } from '../ports/auth.js';
import { boolIn, isUniqueViolation, toIso } from '../db/dialect.js';
import { ensureDefaultAlbum } from '../repositories/albums.js';
import {
  findUserByEmail, findUserById, findUserBySubject, insertUser, updateUser, type UserRow,
} from '../repositories/users.js';

export interface PublicUser {
  id: string;
  email: string;
  displayName: string;
  emailVerified: boolean;
  role: 'admin' | 'member';
  groups: string[];
  plan: string;
  provider: 'local' | 'cognito';
  mfaEnabled: boolean;
  /** auth=local 注册后、邮箱验证前的受限会话：只允许 /api/auth/*、/api/me、/api/me/outbox* */
  restricted: boolean;
  createdAt: string;
}

export interface AdminUserView extends Omit<PublicUser, 'groups' | 'restricted'> {
  disabled: boolean;
  lockedUntil: string | null;
  failedLogins: number;
  photoCount?: number;
}

export function toMe(u: UserRow, principal?: Pick<Principal, 'groups' | 'emailVerified'>): PublicUser {
  const verified = principal?.emailVerified ?? boolIn(u.email_verified);
  return {
    id: u.id,
    email: u.email,
    displayName: u.display_name,
    emailVerified: verified,
    role: u.role,
    groups: principal?.groups ?? [u.role],
    plan: u.plan,
    provider: u.auth_provider,
    mfaEnabled: boolIn(u.mfa_enabled),
    restricted: !verified,
    createdAt: u.created_at,
  };
}

export function toAdminUser(u: UserRow, photoCount?: number): AdminUserView {
  const lockedUntil = toIso(u.locked_until);
  return {
    id: u.id,
    email: u.email,
    displayName: u.display_name,
    emailVerified: boolIn(u.email_verified),
    role: u.role,
    plan: u.plan,
    provider: u.auth_provider,
    mfaEnabled: boolIn(u.mfa_enabled),
    createdAt: u.created_at,
    disabled: boolIn(u.disabled),
    lockedUntil: lockedUntil && Date.parse(lockedUntil) > Date.now() ? lockedUntil : null,
    failedLogins: Number(u.failed_logins ?? 0),
    ...(photoCount !== undefined ? { photoCount } : {}),
  };
}

export function displayNameFromEmail(email: string): string {
  return (email.split('@')[0] ?? 'user').slice(0, 60) || 'user';
}

/** 新建用户 + 默认相册（同一事务，F2） */
export async function createUserWithDefaults(db: Knex, input: Parameters<typeof insertUser>[1]): Promise<UserRow> {
  return db.transaction(async (trx) => {
    const user = await insertUser(trx, input);
    await ensureDefaultAlbum(trx, user.id);
    return user;
  });
}

export class UserDirectory {
  private readonly cache = new Map<string, { userId: string; at: number }>();

  constructor(private readonly db: Knex, private readonly ttlMs = 60_000) {}

  /** Principal → users 行（local 直接按主键；cognito 按 sub JIT 建档） */
  async ensureUser(p: Principal): Promise<UserRow> {
    if (p.provider === 'local') {
      const u = await findUserById(this.db, p.subject);
      if (!u) throw new Error(`本地用户不存在：${p.subject}`);
      return u;
    }
    const key = `${p.provider}:${p.subject}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < this.ttlMs) {
      const u = await findUserById(this.db, hit.userId);
      if (u) return u;
    }
    const user = await this.resolveCognito(p);
    this.cache.set(key, { userId: user.id, at: Date.now() });
    return user;
  }

  /** 只取内部用户 ID（认证中间件每个请求调用；命中缓存时不查库） */
  async userIdOf(p: Principal): Promise<string> {
    if (p.provider === 'local') return p.subject;
    const hit = this.cache.get(`${p.provider}:${p.subject}`);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.userId;
    return (await this.ensureUser(p)).id;
  }

  forget(p: Pick<Principal, 'provider' | 'subject'>): void {
    this.cache.delete(`${p.provider}:${p.subject}`);
  }

  private async resolveCognito(p: Principal): Promise<UserRow> {
    const bySub = await findUserBySubject(this.db, 'cognito', p.subject);
    if (bySub) return bySub;
    const byEmail = p.email ? await findUserByEmail(this.db, p.email) : undefined;
    if (byEmail) {
      await updateUser(this.db, byEmail.id, { auth_provider: 'cognito', auth_subject: p.subject, email_verified: p.emailVerified });
      return (await findUserById(this.db, byEmail.id))!;
    }
    // 令牌里没有 email（AdminGetUser 失败时）：用不可投递的占位地址建档，之后带 email 的请求不会改写它（只按 sub 查找）
    const email = p.email || `${p.subject}@cognito.invalid`;
    try {
      return await createUserWithDefaults(this.db, {
        email, displayName: displayNameFromEmail(email), passwordHash: null, emailVerified: Boolean(p.email) && p.emailVerified,
        role: p.groups.includes('admin') ? 'admin' : 'member', plan: p.plan || 'free', authProvider: 'cognito', authSubject: p.subject,
      });
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      const again = await findUserBySubject(this.db, 'cognito', p.subject);   // 并发的首个请求已经建好了
      if (again) return again;
      throw e;
    }
  }
}
