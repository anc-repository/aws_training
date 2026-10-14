/**
 * notification 实验共用：种子测试用户（seed-users.ts 写入、其他脚本读取）与按用户登录的客户端。
 *
 * 用户清单保存在 `.cloudalbum/experiments/notification-users.json`（0600；含测试账号的密码，只用于本实验，不要放真实账号）。
 * 收件地址是学员邮箱的 `+u1`～`+uN` 子地址（04#notification 第 5 节；平台模式取卡片的前置输入 notify-email，PM-M23），
 * 所有别名都进同一个邮箱，按收件人地址区分。保留域名（example.com 等）的用户不会得到 SNS 订阅。
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loginLocal } from '../_lib/app.js';
import { ExpClient, sharedDispatcher } from '../_lib/http.js';
import type { ScenarioContext } from '../_lib/scenario.js';
import { strParam } from '../_lib/scenario.js';
import { repoRoot } from '../_lib/util.js';

export interface SeededUser {
  /** u1、u2 … */
  alias: string;
  email: string;
  password: string;
  userId: string;
  role: 'admin' | 'member';
  /** 用来接收评论的一张公开照片 */
  photoId?: string;
}

export interface UsersFile {
  target: string;
  base: string;
  createdAt: string;
  users: SeededUser[];
}

export function defaultUsersFile(root: string = repoRoot()): string {
  return path.join(root, '.cloudalbum', 'experiments', 'notification-users.json');
}

/** you@mail.example + u1 → you+u1@mail.example（已有 +tag 时替换） */
export function aliasOf(base: string, tag: string): string {
  const at = base.lastIndexOf('@');
  if (at <= 0) throw new Error(`不是邮件地址：${base}`);
  const local = base.slice(0, at).split('+')[0];
  return `${local}+${tag}@${base.slice(at + 1)}`.toLowerCase();
}

export function readUsersFile(file: string = defaultUsersFile()): UsersFile | undefined {
  if (!existsSync(file)) return undefined;
  return JSON.parse(readFileSync(file, 'utf8')) as UsersFile;
}

export function writeUsersFile(doc: UsersFile, file: string = defaultUsersFile()): string {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    /* Windows */
  }
  return file;
}

/** 场景读取种子用户：`--param users=<file>` > 默认文件；没有时给出可操作的错误 */
export function seededUsers(ctx: Pick<ScenarioContext, 'params'>): SeededUser[] {
  const file = strParam(ctx, 'users', '') || defaultUsersFile();
  const doc = readUsersFile(file);
  if (!doc?.users.length) {
    throw new Error(`没有种子用户（${file}）：先运行 npx tsx experiments/notification/seed-users.ts --count 3 --email <你的邮箱>`);
  }
  return doc.users;
}

/** 以种子用户身份登录（local 驱动），返回带该用户令牌、不带实验头的客户端 */
export async function userClient(base: string, u: Pick<SeededUser, 'email' | 'password'>): Promise<ExpClient> {
  const anon = new ExpClient({ base, recording: false, dispatcher: sharedDispatcher() });
  const r = await loginLocal(anon, u.email, u.password);
  if (!r.token) throw new Error(`${u.email} 登录失败：HTTP ${r.res.status}${r.mfa ? '（开启了 MFA）' : ''}`);
  return new ExpClient({ base, token: r.token, recording: false, dispatcher: sharedDispatcher() });
}

/** Server-Timing 中某个模块段的耗时（毫秒） */
export function timingOf(res: { serverTiming: Array<{ name: string; dur?: number }> }, name: string): number | undefined {
  return res.serverTiming.find((m) => m.name === name)?.dur;
}
