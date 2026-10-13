/**
 * experiments/_lib/login.ts —— `npm run exp:login -- [--target <url>] [--email <管理员邮箱>] [--totp <6 位码>] [--password-stdin]`
 *
 * 以实验管理员登录（local 驱动的 POST /api/auth/login），把 access token 缓存到 `.cloudalbum/experiments/admin-token.json`
 * （0600，按目标区分，过期前 1 分钟失效）。运行器在没有 CLOUDALBUM_ADMIN_TOKEN 时读取它。
 * 密码取 `CLOUDALBUM_ADMIN_PASSWORD`，或 `--password-stdin` 从标准输入读一行；不接受命令行参数形式的密码（会进 shell 历史）。
 * cognito 驱动下浏览器直连 User Pool，此命令不适用：请在浏览器登录后从 /lab 的 Token 查看器复制令牌到 CLOUDALBUM_ADMIN_TOKEN。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { cookieValue, closeSharedDispatcher, ExpClient } from './http.js';
import { loginLocal } from './app.js';
import { resolveTarget, writeCachedToken } from './session.js';

async function readStdinLine(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8').split(/\r?\n/)[0] ?? '';
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const { values } = parseArgs({
    args: argv, strict: true,
    options: { target: { type: 'string' }, email: { type: 'string' }, totp: { type: 'string' }, 'password-stdin': { type: 'boolean' } },
  });
  const target = resolveTarget(values.target);
  const email = values.email ?? process.env.CLOUDALBUM_ADMIN_EMAIL;
  const password = values['password-stdin'] ? await readStdinLine() : process.env.CLOUDALBUM_ADMIN_PASSWORD;
  if (!email || !password) {
    console.error('需要管理员邮箱（--email 或 CLOUDALBUM_ADMIN_EMAIL）与密码（CLOUDALBUM_ADMIN_PASSWORD 或 --password-stdin）');
    return 2;
  }
  const client = new ExpClient({ base: target, recording: false });
  try {
    const r = await loginLocal(client, email, password);
    let token = r.token;
    if (r.mfa) {
      if (!values.totp) {
        console.error('该账号开启了 MFA：加 --totp <6 位验证码> 重试');
        return 2;
      }
      const challengeId = r.res.json<{ challengeId?: string }>().challengeId;
      const v = await client.post('/api/auth/mfa/verify', { auth: false, json: { challengeId, code: values.totp } });
      token = v.ok ? cookieValue(v.setCookie, 'ca_at') : undefined;
    }
    if (!token) {
      console.error(`登录失败：HTTP ${r.res.status || r.res.error}`);
      return 4;
    }
    const caps = await client.child({ token }).get('/api/capabilities');
    const view = caps.ok ? caps.json<{ view?: string }>().view : undefined;
    if (view !== 'admin') console.error(`警告：该账号看到的是 ${view ?? '未知'} 视图，不是管理员；实验头与旁路头对它无效`);
    const file = writeCachedToken(target, token);
    console.error(`已登录 ${email} @ ${target}；令牌缓存在 ${path.relative(process.cwd(), file)}（0600）`);
    return 0;
  } finally {
    await closeSharedDispatcher();
  }
}

const invokedDirectly = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) void main().then((code) => process.exit(code));
