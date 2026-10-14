/**
 * notification/subscribe-users —— 为种子用户开通（或关闭）邮件通知（04#notification 第 6 节“迁移已有的邮件通知设置”的 API 版）。
 *
 *   npx tsx experiments/notification/subscribe-users.ts [--target http://<EIP>] [--off] [--file <users.json>]
 *
 * 以每个种子用户的身份 PUT /api/notifications/prefs {emailEnabled}：
 *   - notification=sns：调用 NotifierPort.subscribeEmail → SNS Subscribe（过滤策略 {"userId":[id]}，管理员另加 audience=admin），
 *     每个地址收到一封 “AWS Notification - Subscription Confirmation”，逐个点击确认后才开始投递；
 *   - notification=db：只改一个布尔值，立即生效。
 * 这是 `node dist/cli.js migrate-module notification up` 在迁移框架接入之前的等价做法（同一个 subscribeEmail）；--off 对应 down。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { closeSharedDispatcher } from '../_lib/http.js';
import { resolveTarget } from '../_lib/session.js';
import { defaultUsersFile, readUsersFile, userClient } from './users.js';

export interface PrefsView { emailEnabled?: boolean; driver?: string; pendingConfirmation?: boolean; sns?: { status?: string } | null }

export async function setSubscriptions(target: string, on: boolean, file: string = defaultUsersFile(), log: (l: string) => void = (l) => console.error(l)): Promise<PrefsView[]> {
  const doc = readUsersFile(file);
  if (!doc?.users.length) throw new Error(`没有种子用户（${file}）：先运行 seed-users.ts`);
  const out: PrefsView[] = [];
  for (const u of doc.users) {
    const client = await userClient(target, u);
    const r = await client.put('/api/notifications/prefs', { route: '/api/notifications/prefs', json: { emailEnabled: on }, expect: [200, 503] });
    const v: PrefsView = r.ok ? r.json<PrefsView>() : {};
    out.push(v);
    if (!r.ok) log(`${u.alias}  ${u.email}  失败：HTTP ${r.status} ${r.text().slice(0, 160)}`);
    else log(`${u.alias}  ${u.email}  driver=${v.driver ?? '?'}  emailEnabled=${String(v.emailEnabled)}  sns=${v.sns?.status ?? '-'}${v.pendingConfirmation ? '  → 请到邮箱点击 AWS 的确认链接' : ''}`);
  }
  return out;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const { values } = parseArgs({ args: argv, strict: true, options: { target: { type: 'string' }, off: { type: 'boolean' }, file: { type: 'string' } } });
  try {
    await setSubscriptions(resolveTarget(values.target), !values.off, values.file ?? defaultUsersFile());
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
