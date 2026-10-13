// backend/src/cli/admin.ts —— 管理员非交互初始化（06 PM-07）与测试用户的哈希校验（PM-44）
//
//   cloudalbum admin:ensure --email <email> --password-hash <PHC> [--reset]
//     只接受 argon2id 的 PHC 字符串（$argon2id$v=19$m=…,t=…,p=…$<salt>$<hash>），参数不得低于应用注册用户时的参数（否则退出 2）；
//     没有该邮箱的用户 → 创建管理员（role=admin、email_verified=true）{"created":true}；已存在 → 不改动 {"created":false}；
//     --reset → 替换哈希并递增 users.token_version（已签发令牌立即失效）{"updated":true}。
// 平台模式下运行器传入的只有哈希（Run Command 参数会留在命令历史中，哈希不可逆）；明文只在 /cloudalbum/<envName>/atl/app-admin-password。
import type { Knex } from 'knex';
import { ARGON2_PARAMS } from '../adapters/auth/local/hash.js';
import { bumpTokenVersion, findUserByEmail, insertUser, updateUser } from '../repositories/users.js';
import { usage } from './platform/common.js';

export interface Argon2idPhc { version: number; m: number; t: number; p: number; salt: string; hash: string }

const PHC_RE = /^\$argon2id\$v=(\d+)\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]{11,64})\$([A-Za-z0-9+/]{16,128})$/;
const EMAIL_RE = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;

export function parseArgon2idPhc(s: string): Argon2idPhc | null {
  const m = PHC_RE.exec(s.trim());
  if (!m) return null;
  return { version: Number(m[1]), m: Number(m[2]), t: Number(m[3]), p: Number(m[4]), salt: m[5]!, hash: m[6]! };
}

/** PHC 校验：argon2id、v=19、参数不低于应用自己的参数（ARGON2_PARAMS） */
export function validatePasswordHash(phc: string): Argon2idPhc {
  const p = parseArgon2idPhc(phc);
  if (!p) throw usage('PASSWORD_HASH_INVALID', '--password-hash must be an argon2id PHC string ($argon2id$v=19$m=…,t=…,p=…$salt$hash)');
  if (p.version !== 19) throw usage('PASSWORD_HASH_INVALID', 'argon2 version must be 19');
  if (p.m < ARGON2_PARAMS.memoryCost || p.t < ARGON2_PARAMS.timeCost || p.p < ARGON2_PARAMS.parallelism) {
    throw usage('PASSWORD_HASH_WEAK', `argon2id parameters must be at least m=${ARGON2_PARAMS.memoryCost},t=${ARGON2_PARAMS.timeCost},p=${ARGON2_PARAMS.parallelism}`);
  }
  return p;
}

export function validateEmail(email: string): string {
  if (!EMAIL_RE.test(email.trim())) throw usage('EMAIL_INVALID', `invalid email ${email}`);
  return email.trim();
}

export async function ensureAdminWithHash(db: Knex, input: { email: string; passwordHash: string; reset?: boolean; displayName?: string }):
  Promise<{ created: true } | { created: false } | { updated: true }> {
  const email = validateEmail(input.email);
  validatePasswordHash(input.passwordHash);
  const existing = await findUserByEmail(db, email);
  if (!existing) {
    await insertUser(db, { email, displayName: input.displayName ?? 'admin', passwordHash: input.passwordHash.trim(), role: 'admin', emailVerified: true });
    return { created: true };
  }
  if (!input.reset) return { created: false };
  await updateUser(db, existing.id, { password_hash: input.passwordHash.trim(), role: 'admin', email_verified: true });
  await bumpTokenVersion(db, existing.id);
  return { updated: true };
}
