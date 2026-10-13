/**
 * experiments/_lib/session.ts —— 目标地址与管理员令牌（总纲 §8.2 运行器第 1 步）。
 *
 * 目标：`--target` > `EXP_TARGET` > `.cloudalbum/state.json` 中的 APP_BASE_URL > `http://localhost:3000`。
 * 令牌：`--token` > `CLOUDALBUM_ADMIN_TOKEN` > `npm run exp:login` 缓存（`.cloudalbum/experiments/admin-token.json`，0600，未过期且目标一致）
 *       > 用 `CLOUDALBUM_ADMIN_EMAIL` / `CLOUDALBUM_ADMIN_PASSWORD` 现场登录（local 驱动）。
 * 令牌只在内存与本机缓存文件中出现，不写进结果 JSON、不打印。
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { decodeJwt, loginLocal } from './app.js';
import { ExpClient } from './http.js';
import { isRecord, repoRoot } from './util.js';

export const DEFAULT_TARGET = 'http://localhost:3000';

function stateFile(root: string): string {
  return path.join(root, '.cloudalbum', 'state.json');
}

/** 从 state.json 中找 APP_BASE_URL（scripts/module 维护，字段名容错）。 */
export function targetFromState(root: string = repoRoot()): string | undefined {
  const file = stateFile(root);
  if (!existsSync(file)) return undefined;
  try {
    const s = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    const candidates = [
      s.APP_BASE_URL, s.appBaseUrl, (s.env as Record<string, unknown> | undefined)?.APP_BASE_URL,
      (s.base as Record<string, unknown> | undefined)?.appBaseUrl, (s.outputs as Record<string, unknown> | undefined)?.AppBaseUrl,
      (s.entry as Record<string, unknown> | undefined)?.baseUrl,
    ];
    const found = candidates.find((c) => typeof c === 'string' && /^https?:\/\//.test(c));
    return found as string | undefined;
  } catch {
    return undefined;
  }
}

export function resolveTarget(arg: string | undefined, env: NodeJS.ProcessEnv = process.env, root?: string): string {
  const t = arg ?? env.EXP_TARGET ?? targetFromState(root) ?? DEFAULT_TARGET;
  if (!/^https?:\/\//i.test(t)) throw new Error(`目标地址必须以 http:// 或 https:// 开头：${t}`);
  return t.replace(/\/+$/, '');
}

export function tokenCacheFile(root: string = repoRoot()): string {
  return path.join(root, '.cloudalbum', 'experiments', 'admin-token.json');
}

export function tokenExpiry(token: string): number | undefined {
  const exp = decodeJwt(token)?.payload.exp;
  return typeof exp === 'number' ? exp * 1000 : undefined;
}

export function readCachedToken(target: string, root?: string, now = Date.now()): string | undefined {
  const file = tokenCacheFile(root);
  if (!existsSync(file)) return undefined;
  try {
    const c = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    if (!isRecord(c) || c.target !== target || typeof c.token !== 'string') return undefined;
    const exp = tokenExpiry(c.token);
    if (exp !== undefined && exp - now < 60_000) return undefined;
    return c.token;
  } catch {
    return undefined;
  }
}

export function writeCachedToken(target: string, token: string, root?: string): string {
  const file = tokenCacheFile(root);
  mkdirSync(path.dirname(file), { recursive: true });
  const exp = tokenExpiry(token);
  writeFileSync(file, `${JSON.stringify({ target, token, ...(exp ? { expiresAt: new Date(exp).toISOString() } : {}) }, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    /* Windows */
  }
  return file;
}

export interface TokenResolution {
  token?: string;
  source: 'arg' | 'env' | 'cache' | 'login' | 'none';
  credentials?: { email: string; password: string };
  error?: string;
}

export async function resolveAdminToken(opts: { target: string; token?: string; env?: NodeJS.ProcessEnv; root?: string; login?: boolean }): Promise<TokenResolution> {
  const env = opts.env ?? process.env;
  const credentials = env.CLOUDALBUM_ADMIN_EMAIL && env.CLOUDALBUM_ADMIN_PASSWORD
    ? { email: env.CLOUDALBUM_ADMIN_EMAIL, password: env.CLOUDALBUM_ADMIN_PASSWORD } : undefined;
  const withCreds = <T extends TokenResolution>(r: T): T => (credentials ? { ...r, credentials } : r);
  if (opts.token) return withCreds({ token: opts.token, source: 'arg' });
  if (env.CLOUDALBUM_ADMIN_TOKEN) return withCreds({ token: env.CLOUDALBUM_ADMIN_TOKEN, source: 'env' });
  const cached = readCachedToken(opts.target, opts.root);
  if (cached) return withCreds({ token: cached, source: 'cache' });
  if (credentials && opts.login !== false) {
    const client = new ExpClient({ base: opts.target, recording: false });
    const r = await loginLocal(client, credentials.email, credentials.password);
    if (r.token) return { token: r.token, source: 'login', credentials };
    return { source: 'none', credentials, error: r.mfa ? '管理员账号开启了 MFA：请先 npm run exp:login 或设置 CLOUDALBUM_ADMIN_TOKEN' : `登录失败：HTTP ${r.res.status || r.res.error}` };
  }
  return { source: 'none', error: '没有管理员令牌：设置 CLOUDALBUM_ADMIN_TOKEN，或 CLOUDALBUM_ADMIN_EMAIL + CLOUDALBUM_ADMIN_PASSWORD，或先运行 npm run exp:login' };
}
