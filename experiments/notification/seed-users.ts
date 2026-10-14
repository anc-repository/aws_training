/**
 * notification/seed-users —— 准备测试用户（04#notification 第 5 节步骤 1；卡片 svc-notification 的 seed 步骤）。
 *
 *   npx tsx experiments/notification/seed-users.ts --count 3 --email you@example.com [--target http://<EIP>] [--no-admins]
 *
 * 对每个 i = 1..count，经 CloudAlbum 的公开 API（不直连数据库）：
 *   1. 注册 `<you>+u<i>@<domain>`（随机密码；已注册过则沿用清单中的密码）；
 *   2. 以管理员身份在 /api/admin/outbox 找到验证邮件，用其中的验证码 POST /api/auth/confirm（email=outbox 档；ses 档请到邮箱点链接）；
 *   3. 以该用户登录，上传一张公开的小照片（之后 fanout / filter 给它评论），并打开“邮件通知”（PUT /api/notifications/prefs）；
 *   4. 默认再把它设为管理员（PATCH /api/admin/users/:id），用来测“管理员广播”；`--no-admins` 保持普通用户。
 * 结果写入 `.cloudalbum/experiments/notification-users.json`（0600）。管理员令牌的取法与运行器相同（npm run exp:login）。
 * 在 db 档运行：打开邮件通知只改一个布尔值；sns 档请改用 subscribe-users.ts（每人收到一封 AWS 确认邮件）。
 */
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { closeSharedDispatcher, ExpClient, sharedDispatcher } from '../_lib/http.js';
import { fallbackJpeg } from '../_lib/images.js';
import { resolveAdminToken, resolveTarget } from '../_lib/session.js';
import { sleep } from '../_lib/util.js';
import { aliasOf, defaultUsersFile, readUsersFile, userClient, writeUsersFile, type SeededUser, type UsersFile } from './users.js';

export interface SeedOptions {
  target: string;
  adminToken: string;
  email: string;
  count: number;
  admins: boolean;
  file?: string;
  log?: (line: string) => void;
}

const RESERVED = /@([a-z0-9.-]+\.)?example\.(com|net|org)$|\.(example|invalid|test|localhost)$/i;

function newPassword(): string {
  return `Np-${randomBytes(12).toString('base64url')}-9a`;
}

/** 管理员在 outbox 中找最新一封验证邮件，取出验证码（链接 /verify?email=…&code=…） */
async function verificationCode(admin: ExpClient, email: string): Promise<string | undefined> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const list = await admin.get(`/api/admin/outbox?to=${encodeURIComponent(email)}&category=verification&limit=1`, { route: '/api/admin/outbox' });
    const row = list.ok ? list.json<{ items?: Array<{ id: string }> }>().items?.[0] : undefined;
    if (row) {
      const detail = await admin.get(`/api/admin/outbox/${encodeURIComponent(row.id)}`, { route: '/api/admin/outbox/:id' });
      const links = detail.ok ? detail.json<{ links?: string[] }>().links ?? [] : [];
      for (const l of links) {
        const code = new URL(l).searchParams.get('code');
        if (code) return code;
      }
      return undefined;   // ses 档：outbox 只有发送记录，没有正文
    }
    await sleep(500);
  }
  return undefined;
}

async function uploadPublicPhoto(client: ExpClient, title: string): Promise<string | undefined> {
  const image = fallbackJpeg();
  const create = await client.post('/api/photos', {
    route: '/api/photos', json: { contentType: 'image/jpeg', size: image.length, filename: 'notification-seed.jpg', visibility: 'public', title },
  });
  if (!create.ok) return undefined;
  const body = create.json<{ photoId?: string; uploadTarget?: { method?: string; url: string; headers?: Record<string, string> } }>();
  if (!body.photoId || !body.uploadTarget) return undefined;
  const t = body.uploadTarget;
  const absolute = /^https?:\/\//i.test(t.url);
  const put = absolute && new URL(t.url).origin !== new URL(client.base).origin
    ? await new ExpClient({ base: new URL(t.url).origin, recording: false, dispatcher: sharedDispatcher() }).request(t.method ?? 'PUT', t.url, { headers: t.headers ?? {}, body: image, auth: false })
    : await client.request(t.method ?? 'PUT', t.url, { headers: t.headers ?? {}, body: image, route: '/api/storage/upload' });
  if (!put.ok) return undefined;
  const done = await client.post(`/api/photos/${body.photoId}/complete`, { route: '/api/photos/:id/complete', json: {} });
  if (!done.ok) return undefined;
  for (let i = 0; i < 60; i += 1) {
    const p = await client.get(`/api/photos/${body.photoId}`, { route: '/api/photos/:id' });
    const status = p.ok ? (p.json<{ status?: string; photo?: { status?: string } }>().status ?? p.json<{ photo?: { status?: string } }>().photo?.status) : undefined;
    if (status === 'READY') return body.photoId;
    if (status === 'FAILED') return undefined;
    await sleep(1000);
  }
  return body.photoId;
}

export async function seedUsers(o: SeedOptions): Promise<UsersFile> {
  const log = o.log ?? ((l: string) => console.error(l));
  const file = o.file ?? defaultUsersFile();
  const previous = readUsersFile(file);
  const admin = new ExpClient({ base: o.target, token: o.adminToken, recording: false, dispatcher: sharedDispatcher() });
  const anon = new ExpClient({ base: o.target, recording: false, dispatcher: sharedDispatcher() });
  if (RESERVED.test(o.email)) log(`注意：${o.email} 是保留域名，sns 档不会为这些地址创建邮件订阅（PM-46 / PM-M23）`);
  const users: SeededUser[] = [];
  for (let i = 1; i <= o.count; i += 1) {
    const alias = `u${i}`;
    const email = aliasOf(o.email, alias);
    const known = previous?.users.find((u) => u.email === email);
    const password = known?.password ?? newPassword();
    const reg = await anon.post('/api/auth/register', { route: '/api/auth/register', auth: false, json: { email, password, displayName: alias }, expect: [201, 409] });
    if (reg.status === 409 && !known) throw new Error(`${email} 已注册但不在 ${file} 中（不知道密码）：换一个 --email，或删掉该用户`);
    if (reg.status === 201) {
      const code = await verificationCode(admin, email);
      if (code) {
        const ok = await anon.post('/api/auth/confirm', { route: '/api/auth/confirm', auth: false, json: { email, code }, expect: [200, 400] });
        if (!ok.ok) log(`${email}：验证码确认失败（HTTP ${ok.status}）`);
      } else {
        log(`${email}：outbox 中没有验证邮件正文（email=ses？）——请到邮箱点击验证链接，然后重新运行本命令`);
      }
    }
    const client = await userClient(o.target, { email, password });
    const me = await client.get('/api/me', { route: '/api/me' });
    const userId = me.ok ? (me.json<{ id?: string; userId?: string; user?: { id?: string } }>().id ?? me.json<{ userId?: string }>().userId ?? '') : '';
    if (!userId) throw new Error(`${email}：读不到 /api/me（HTTP ${me.status}）`);
    const photoId = known?.photoId ?? await uploadPublicPhoto(client, `notification seed ${alias}`);
    const prefs = await client.put('/api/notifications/prefs', { route: '/api/notifications/prefs', json: { emailEnabled: true } });
    const prefsBody = prefs.ok ? prefs.json<{ driver?: string; pendingConfirmation?: boolean }>() : {};
    let role: SeededUser['role'] = 'member';
    if (o.admins) {
      const r = await admin.request('PATCH', `/api/admin/users/${encodeURIComponent(userId)}`, { route: '/api/admin/users/:id', json: { role: 'admin' } });
      if (r.ok) role = 'admin';
      else log(`${email}：设为管理员失败（HTTP ${r.status}）`);
    }
    users.push({ alias, email, password, userId, role, ...(photoId ? { photoId } : {}) });
    log(`${alias}  ${email}  ${role}  photo=${photoId ?? '-'}  邮件通知=on（${prefsBody.driver ?? '?'}${prefsBody.pendingConfirmation ? '，等待确认' : ''}）`);
  }
  const doc: UsersFile = { target: o.target, base: o.email, createdAt: new Date().toISOString(), users };
  writeUsersFile(doc, file);
  log(`已写入 ${path.relative(process.cwd(), file)}（0600）`);
  return doc;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const { values } = parseArgs({
    args: argv, strict: true,
    options: {
      target: { type: 'string' }, email: { type: 'string' }, count: { type: 'string', default: '3' },
      'no-admins': { type: 'boolean' }, file: { type: 'string' },
    },
  });
  const email = values.email ?? process.env.NOTIFY_EMAIL;
  if (!email || !email.includes('@')) {
    console.error('用法：npx tsx experiments/notification/seed-users.ts --count 3 --email <你的邮箱> [--target <url>] [--no-admins]');
    return 2;
  }
  const count = Math.max(1, Math.min(20, Number(values.count) || 3));
  const target = resolveTarget(values.target);
  try {
    const tok = await resolveAdminToken({ target });
    if (!tok.token) {
      console.error(tok.error ?? '没有管理员令牌');
      return 4;
    }
    await seedUsers({ target, adminToken: tok.token, email, count, admins: !values['no-admins'], ...(values.file ? { file: values.file } : {}) });
    return 0;
  } catch (e) {
    console.error((e as Error).message);
    return 1;
  } finally {
    await closeSharedDispatcher();
  }
}

const invokedDirectly = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) void main().then((code) => process.exit(code));
