// backend/src/lab/seeds/cognito-test-users.ts —— 种子 cognito-test-users 的实验机部分（06 PM-44）
//
// 平台侧（scripts/module seed cognito-test-users）生成 3 个测试用户 atl-test-1～atl-test-3 的随机密码，明文写入 SecureString
// /cloudalbum/<envName>/atl/test-users，并用 argon2id 计算哈希；经 SSM 执行
//   cloudalbum seed cognito-test-users --users-b64 <base64url([{username,email,passwordHash}])>
// 这里在 users 表中创建或更新用户（role=member、email_verified=true、seed_id='cognito-test-users'），只收哈希。
// auth 已经是 cognito 时同样写本地行（JIT 建档在首次登录时关联 auth_subject）；Cognito 中的密码由钩子 cognito-passwords
// 以学员身份设置（PM-36）。幂等依据：邮箱 + seed_id（不是本种子创建的同邮箱账号保持不变）。
import type { Knex } from 'knex';
import { isReservedEmailDomain } from '@cloudalbum/contracts';
import { ensureDefaultAlbum } from '../../repositories/albums.js';
import { findUserByEmail, insertUser, updateUser } from '../../repositories/users.js';
import { validatePasswordHash } from '../../cli/admin.js';
import { usage } from '../../cli/platform/common.js';

export const COGNITO_TEST_USERS_SEED = 'cognito-test-users';
const USERNAME_RE = /^atl-test-[1-9]$/;

export interface SeedUserInput { username: string; email: string; passwordHash: string }

export function decodeSeedUsers(b64: string): SeedUserInput[] {
  if (!/^[A-Za-z0-9_-]{1,6000}={0,2}$/.test(b64)) throw usage('ARG_INVALID', '--users-b64 must be base64url');
  let list: unknown;
  try {
    list = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'));
  } catch {
    throw usage('ARG_INVALID', '--users-b64 is not JSON');
  }
  if (!Array.isArray(list) || list.length < 1 || list.length > 9) throw usage('ARG_INVALID', '--users-b64 must be a JSON array of 1..9 users');
  return list.map((u, i) => {
    const o = u as Record<string, unknown>;
    const username = String(o.username ?? '');
    const email = String(o.email ?? '').trim().toLowerCase();
    const passwordHash = String(o.passwordHash ?? '');
    if (!USERNAME_RE.test(username)) throw usage('ARG_INVALID', `users[${i}].username must match ${USERNAME_RE.source}`);
    if (!isReservedEmailDomain(email) || !/^[a-z0-9._+-]+@[a-z0-9.-]+$/.test(email)) {
      throw usage('ARG_INVALID', `users[${i}].email must use a reserved domain such as example.com (06 PM-46)`);
    }
    validatePasswordHash(passwordHash);
    if ('password' in o) throw usage('ARG_INVALID', 'plaintext passwords are never accepted (hashes only)');
    return { username, email, passwordHash };
  });
}

export async function seedCognitoTestUsers(db: Knex, users: readonly SeedUserInput[]): Promise<{ seed: string; created: number; updated: number; unchanged: number; skipped: string[] }> {
  let created = 0;
  let updated = 0;
  let unchanged = 0;
  const skipped: string[] = [];
  for (const u of users) {
    const existing = (await findUserByEmail(db, u.email)) as (Awaited<ReturnType<typeof findUserByEmail>> & { seed_id?: string | null }) | undefined;
    if (!existing) {
      const row = await insertUser(db, { email: u.email, displayName: u.username, passwordHash: u.passwordHash, role: 'member', emailVerified: true });
      await db('users').where({ id: row.id }).update({ seed_id: COGNITO_TEST_USERS_SEED });
      await ensureDefaultAlbum(db, row.id);
      created += 1;
      continue;
    }
    if (existing.seed_id !== COGNITO_TEST_USERS_SEED) {
      skipped.push(u.email);                       // 学员自己注册的同邮箱账号：不改动
      continue;
    }
    if (existing.password_hash === u.passwordHash && (existing.email_verified === true || existing.email_verified === 1)) {
      unchanged += 1;
      continue;
    }
    // auth=cognito 迁移后本地行没有密码哈希：保持为 null（Cognito 中的密码由钩子设置）
    await updateUser(db, existing.id, { email_verified: true, ...(existing.auth_provider === 'local' ? { password_hash: u.passwordHash } : {}) });
    updated += 1;
  }
  return { seed: COGNITO_TEST_USERS_SEED, created, updated, unchanged, skipped };
}
