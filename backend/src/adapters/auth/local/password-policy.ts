// backend/src/adapters/auth/local/password-policy.ts —— 本地密码策略 + 常见密码黑名单（02#auth 第 1 节“防护”）
//
// 黑名单：内置一小份最常见的密码；若存在 /usr/share/cloudalbum/common-passwords.txt（每行一个），一并加载。
import { readFileSync } from 'node:fs';
import type { AuthPublicConfig } from '../../../ports/auth.js';
import { MAX_PASSWORD_LENGTH } from './hash.js';

export const PASSWORD_POLICY: AuthPublicConfig['passwordPolicy'] = {
  minLength: 8,
  requireUpper: false,
  requireDigit: true,
  requireSymbol: false,
};

export const COMMON_PASSWORDS_FILE = '/usr/share/cloudalbum/common-passwords.txt';

const BUILTIN_COMMON = [
  '12345678', '123456789', '1234567890', 'password', 'password1', 'password123', 'qwerty123', 'qwertyuiop', '11111111',
  '00000000', 'abc12345', 'abcd1234', 'iloveyou1', 'admin123', 'welcome1', 'letmein1', 'passw0rd', 'p@ssw0rd', '1q2w3e4r',
  '1qaz2wsx', 'zaq12wsx', 'cloudalbum1', 'changeme1', 'sunshine1', 'football1', 'monkey123', 'dragon123',
];

let common: Set<string> | undefined;

function commonPasswords(file = COMMON_PASSWORDS_FILE): Set<string> {
  if (common) return common;
  const set = new Set(BUILTIN_COMMON);
  try {
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const w = line.trim().toLowerCase();
      if (w && !w.startsWith('#')) set.add(w);
    }
  } catch {
    /* 文件可选 */
  }
  common = set;
  return set;
}

/** 返回违反的规则（空数组 = 通过） */
export function checkPassword(password: string, ctx: { email?: string } = {}): string[] {
  const v: string[] = [];
  const p = PASSWORD_POLICY;
  if (password.length < p.minLength) v.push(`至少 ${p.minLength} 个字符`);
  if (password.length > MAX_PASSWORD_LENGTH) v.push(`最多 ${MAX_PASSWORD_LENGTH} 个字符`);
  if (!/[A-Za-z]/.test(password)) v.push('至少包含一个字母');
  if (p.requireDigit && !/\d/.test(password)) v.push('至少包含一个数字');
  if (p.requireUpper && !/[A-Z]/.test(password)) v.push('至少包含一个大写字母');
  if (p.requireSymbol && !/[^A-Za-z0-9]/.test(password)) v.push('至少包含一个符号');
  if (commonPasswords().has(password.toLowerCase())) v.push('不能使用常见密码');
  const local = ctx.email?.split('@')[0]?.toLowerCase();
  if (local && local.length >= 4 && password.toLowerCase().includes(local)) v.push('不能包含邮箱用户名');
  return v;
}
