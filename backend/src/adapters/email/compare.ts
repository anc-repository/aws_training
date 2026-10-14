// backend/src/adapters/email/compare.ts —— POST /api/lab/email/compare 的功能对照（04#email 第 5 节；wave1-sns-ses）
//
// 用同一封邮件（同一份 MIME 构造代码）分别经 outbox 驱动（写本机 .eml）和 ses 驱动（SendEmail）各发一次，只发给管理员指定的地址，
// 并排返回耗时与结果。outbox 驱动在 ses 档下按需临时构造；ses 档未启用时只跑 outbox 一侧。
// 路由（仅管理员）由集成阶段在 http/routes 中登记：`res.json(await compareEmailDrivers(deps, c.email, body.to))`。
import { performance } from 'node:perf_hooks';
import { HttpError } from '../../errors.js';
import type { EmailMessage, EmailPort } from '../../ports/email.js';
import type { AdapterDeps } from '../types.js';
import { OutboxEmail } from './outbox.js';
import { isReservedAddress } from './reserved.js';

export interface EmailDriverRun {
  ms: number;
  messageId?: string;
  transport?: 'outbox' | 'ses';
  delivered?: boolean;
  error?: string;
}

export interface EmailCompareResult {
  to: string;
  reserved: boolean;
  outbox: EmailDriverRun;
  ses: EmailDriverRun | { skipped: string };
  note: string;
}

const EMAIL_RE = /^[^\s@<>()"]+@[^\s@<>()"]+\.[^\s@<>()"]+$/;

export function compareMessage(to: string): EmailMessage {
  const at = new Date().toISOString();
  return {
    to: [to], category: 'system', tags: { flow: 'compare' },
    subject: 'CloudAlbum 功能对照：同一封邮件经 outbox 与 SES 各发一次',
    text: `这是 /api/lab/email/compare 在 ${at} 发出的对照邮件。\n同一份内容分别写进本机 outbox 并经 Amazon SES 发出；在邮箱中“显示原始邮件”可以看到 SES 加上的 DKIM-Signature。`,
    html: `<p>这是 <code>/api/lab/email/compare</code> 在 ${at} 发出的对照邮件。</p><p>同一份内容分别写进本机 outbox 并经 Amazon SES 发出；在邮箱中“显示原始邮件”可以看到 SES 加上的 <code>DKIM-Signature</code>。</p>`,
  };
}

async function run(port: EmailPort, msg: EmailMessage): Promise<EmailDriverRun> {
  const t0 = performance.now();
  try {
    const r = await port.send(msg);
    return { ms: Math.round((performance.now() - t0) * 10) / 10, ...r };
  } catch (e) {
    return { ms: Math.round((performance.now() - t0) * 10) / 10, error: (e as Error).message };
  }
}

/** current = 当前装配的 EmailPort（c.email） */
export async function compareEmailDrivers(deps: AdapterDeps, current: EmailPort, to: string): Promise<EmailCompareResult> {
  const addr = (to ?? '').trim().toLowerCase();
  if (!EMAIL_RE.test(addr)) throw new HttpError(400, 'VALIDATION_FAILED', 'to 必须是一个邮件地址');
  const msg = compareMessage(addr);
  const outbox = await run(new OutboxEmail(deps), msg);
  const ses = current.meta.driver === 'ses'
    ? await run(current, msg)
    : { skipped: `EMAIL_DRIVER=${current.meta.driver}：ses 驱动未启用（scripts/module enable email）` };
  return {
    to: addr, reserved: isReservedAddress(addr), outbox, ses,
    note: 'outbox 只写本机文件与数据库（毫秒级，未真正发出）；ses 多一次 HTTPS API 调用。沙盒期收件人必须是已验证地址，否则 ses 一侧为 MessageRejected',
  };
}
