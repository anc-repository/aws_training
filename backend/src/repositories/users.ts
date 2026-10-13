// backend/src/repositories/users.ts —— users 表（脚手架只提供 CLI admin:create 需要的最小集合；auth / L0 实现者扩展）
import { randomUUID } from 'node:crypto';
import type { Knex } from 'knex';
import { countOf, nowIso } from '../db/dialect.js';

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
}

export async function findUserByEmail(db: Knex, email: string): Promise<UserRow | undefined> {
  return (await db('users').where({ email: email.trim().toLowerCase() }).first()) as UserRow | undefined;
}

export async function countAdmins(db: Knex): Promise<number> {
  return countOf(await db('users').where({ role: 'admin' }).count({ count: '*' }).first());
}

/**
 * 新建用户（不含默认相册等业务副作用；注册流程由 auth 实现者在服务层完成）。
 * local 模式下 auth_subject = users.id（02#auth 第 1 节）。
 */
export async function insertUser(db: Knex | Knex.Transaction, input: {
  email: string; displayName: string; passwordHash: string | null; role?: 'admin' | 'member';
  emailVerified?: boolean; plan?: string; authProvider?: 'local' | 'cognito'; authSubject?: string;
}): Promise<UserRow> {
  const id = randomUUID();
  const now = nowIso();
  const row = {
    id,
    email: input.email.trim().toLowerCase(),
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
