// backend/src/adapters/auth/local/hash.ts —— argon2id 密码哈希（@node-rs/argon2，按需动态 import）
//
// 参数取 OWASP 推荐的 argon2id 下限（19 MiB、t=2、p=1），与 cli.ts 的 admin:create 一致：
// 登录压测时 argon2 会占用 EC2 的 CPU，这本身就是 auth 模块“有 vs 没有 Cognito”的对比点（02#auth 第 5 节）。
import type * as Argon2 from '@node-rs/argon2';

export const ARGON2_PARAMS = { memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

/** 密码长度上限：防止超长输入拖慢 argon2（DoS） */
export const MAX_PASSWORD_LENGTH = 256;

type Argon2Module = Pick<typeof Argon2, 'hash' | 'verify'>;
let loaded: Promise<Argon2Module> | undefined;

async function argon2(): Promise<Argon2Module> {
  loaded ??= import('@node-rs/argon2').then((m) => {
    const mod = m as unknown as Partial<Argon2Module> & { default?: Argon2Module };
    return mod.hash && mod.verify ? (mod as Argon2Module) : mod.default!;
  });
  return loaded;
}

export async function hashPassword(password: string): Promise<string> {
  return (await argon2()).hash(password, { ...ARGON2_PARAMS });
}

/** 校验失败、哈希格式错误一律返回 false（不抛出） */
export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  if (!hash || password.length > MAX_PASSWORD_LENGTH) return false;
  try {
    return await (await argon2()).verify(hash, password);
  } catch {
    return false;
  }
}

let dummyHash: Promise<string> | undefined;

/** 用户不存在时也做一次等价的 argon2 校验，使响应时间不泄露“邮箱是否注册过”（防枚举） */
export async function dummyVerify(password: string): Promise<void> {
  dummyHash ??= hashPassword('cloudalbum-dummy-password-for-timing');
  await verifyPassword(await dummyHash, password.slice(0, MAX_PASSWORD_LENGTH));
}
