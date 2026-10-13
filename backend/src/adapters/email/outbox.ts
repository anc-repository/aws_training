// backend/src/adapters/email/outbox.ts —— EmailPort 的 `outbox` 驱动（本地实现，04#email 第 1 节）
//
// - 生成标准的 RFC 822 邮件（multipart/alternative，正文 base64），保存为 OUTBOX_DIR/<yyyy-mm-dd>/<messageId>.eml
//   （先写 .tmp 再 rename），同时写 outbox_emails 表（eml_path 存相对 OUTBOX_DIR 的逻辑路径，不存绝对路径）。
// - send() 返回 delivered=false：明确表示“邮件没有真正发出去”。管理员在 /admin/outbox、本人在 /me/outbox 查看。
// - 收件人只有一个且是本站用户时记 user_id（/me/outbox 据此过滤）。
// - MIME 构造与解析放在本文件（ses 档实现时可复用 buildMime，保证两档内容一致）。
import { accessSync, constants as fsConstants, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';
import { ulid } from 'ulid';
import type { AdapterDeps } from '../types.js';
import { need } from '../types.js';
import type { AdapterMeta, ProbeResult } from '../../ports/common.js';
import type { EmailMessage, EmailPort } from '../../ports/email.js';
import { markPath } from '../../observability/request-context.js';
import { countOutbox, insertOutboxEmail, listOutbox, type OutboxEmailRow } from '../../repositories/outbox.js';
import { findUserByEmail } from '../../repositories/users.js';

// ------------------------------------------------------------------------------------------------
// MIME
// ------------------------------------------------------------------------------------------------

function encodeHeaderWord(s: string): string {
  return /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
}

function wrap76(b64: string): string {
  return b64.replace(/.{1,76}/g, (m) => `${m}\r\n`);
}

export interface MimeInput extends EmailMessage { from: string; messageId: string; date?: Date; transport?: 'outbox' | 'ses' }

/** 构造 RFC 822 文本（CRLF 换行） */
export function buildMime(m: MimeInput): string {
  const boundary = `ca-${m.messageId.replace(/[^A-Za-z0-9]/g, '').slice(0, 24)}-alt`;
  const domain = m.from.match(/@([^>\s]+)/)?.[1] ?? 'cloudalbum.local';
  const headers = [
    `From: ${encodeHeaderWord(m.from)}`,
    `To: ${m.to.join(', ')}`,
    `Subject: ${encodeHeaderWord(m.subject)}`,
    `Date: ${(m.date ?? new Date()).toUTCString()}`,
    `Message-ID: <${m.messageId}@${domain}>`,
    'MIME-Version: 1.0',
    `X-CloudAlbum-Category: ${m.category}`,
    `X-CloudAlbum-Transport: ${m.transport ?? 'outbox'}`,
    ...Object.entries(m.tags ?? {}).map(([k, v]) => `X-CloudAlbum-Tag-${k.replace(/[^A-Za-z0-9-]/g, '')}: ${encodeHeaderWord(String(v))}`),
  ];
  const part = (type: string, body: string) => [
    `Content-Type: ${type}; charset=UTF-8`,
    'Content-Transfer-Encoding: base64',
    '',
    wrap76(Buffer.from(body, 'utf8').toString('base64')),
  ].join('\r\n');
  if (!m.html) {
    return [...headers, part('text/plain', m.text)].join('\r\n');
  }
  return [
    ...headers,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    part('text/plain', m.text),
    `--${boundary}`,
    part('text/html', m.html),
    `--${boundary}--`,
    '',
  ].join('\r\n');
}

function parseHeaders(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  const unfolded = block.replace(/\r?\n[ \t]+/g, ' ');
  for (const line of unfolded.split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return out;
}

function decodeHeaderWord(s: string): string {
  return s.replace(/=\?UTF-8\?B\?([^?]+)\?=/gi, (_m, b64: string) => Buffer.from(b64, 'base64').toString('utf8'));
}

function decodeBody(headers: Record<string, string>, body: string): string {
  const enc = (headers['content-transfer-encoding'] ?? '').toLowerCase();
  if (enc === 'base64') return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8');
  if (enc === 'quoted-printable') {
    return Buffer.from(body.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/gi, (_m, h: string) => String.fromCharCode(parseInt(h, 16))), 'latin1')
      .toString('utf8');
  }
  return body;
}

export interface ParsedEml { headers: Record<string, string>; from?: string; subject?: string; text: string | null; html: string | null }

/** 解析本驱动生成的 .eml（也能处理一般的单段 / multipart 邮件） */
export function parseEml(raw: string): ParsedEml {
  const split = raw.search(/\r?\n\r?\n/);
  const headerBlock = split === -1 ? raw : raw.slice(0, split);
  const body = split === -1 ? '' : raw.slice(split).replace(/^\r?\n\r?\n/, '');
  const headers = parseHeaders(headerBlock);
  const ct = headers['content-type'] ?? 'text/plain';
  let text: string | null = null;
  let html: string | null = null;
  const boundary = /boundary="?([^";]+)"?/i.exec(ct)?.[1];
  if (/^multipart\//i.test(ct) && boundary) {
    for (const seg of body.split(`--${boundary}`)) {
      const s = seg.replace(/^\r?\n/, '');
      if (!s.trim() || s.startsWith('--')) continue;
      const p = s.search(/\r?\n\r?\n/);
      if (p === -1) continue;
      const ph = parseHeaders(s.slice(0, p));
      const pb = decodeBody(ph, s.slice(p).replace(/^\r?\n\r?\n/, ''));
      const pct = (ph['content-type'] ?? '').toLowerCase();
      if (pct.startsWith('text/html')) html = pb;
      else if (pct.startsWith('text/plain')) text = pb;
    }
  } else if (/^text\/html/i.test(ct)) {
    html = decodeBody(headers, body);
  } else {
    text = decodeBody(headers, body);
  }
  return {
    headers,
    ...(headers.from ? { from: decodeHeaderWord(headers.from) } : {}),
    ...(headers.subject ? { subject: decodeHeaderWord(headers.subject) } : {}),
    text,
    html,
  };
}

/** 从正文中提取 http(s) 链接（/me/outbox 页面与冒烟测试据此点击验证链接） */
export function extractLinks(text: string | null): string[] {
  if (!text) return [];
  return [...new Set(text.match(/https?:\/\/[^\s<>"')]+/g) ?? [])];
}

// ------------------------------------------------------------------------------------------------
// 驱动
// ------------------------------------------------------------------------------------------------

export class OutboxEmail implements EmailPort {
  readonly meta: AdapterMeta = { module: 'email', driver: 'outbox', awsService: null, authoritative: false };

  constructor(protected readonly deps: AdapterDeps) {}

  get outboxDir(): string {
    return this.deps.cfg.email.OUTBOX_DIR;
  }

  /** eml_path（相对 OUTBOX_DIR，'/' 分隔）→ 绝对路径；拒绝跳出 OUTBOX_DIR 的路径 */
  resolveEmlPath(emlPath: string): string {
    const abs = path.resolve(this.outboxDir, ...emlPath.split('/'));
    const root = path.resolve(this.outboxDir);
    if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error('eml_path 越界');
    return abs;
  }

  async send(msg: EmailMessage): Promise<{ messageId: string; transport: 'outbox' | 'ses'; delivered: boolean }> {
    const db = need(this.deps, 'db', 'OutboxEmail');
    if (!msg.to.length) throw new Error('EmailMessage.to 不能为空');
    const messageId = ulid();
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    const emlPath = `${day}/${messageId}.eml`;
    const file = this.resolveEmlPath(emlPath);
    const mime = buildMime({ ...msg, from: this.deps.cfg.email.EMAIL_FROM, messageId, date: now, transport: 'outbox' });
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, mime, { encoding: 'utf8' });
    renameSync(tmp, file);
    let userId: string | null = null;
    if (msg.to.length === 1) userId = (await findUserByEmail(db, msg.to[0]!))?.id ?? null;
    await insertOutboxEmail(db, {
      messageId, to: msg.to.map((a) => a.trim().toLowerCase()), subject: msg.subject, category: msg.category, transport: 'outbox',
      status: 'sent', userId, emlPath, sentAt: now.toISOString(),
    });
    markPath('email', 'outbox:stored');
    return { messageId, transport: 'outbox', delivered: false };
  }

  async listRecent(limit: number): Promise<Array<{ messageId: string; to: string[]; subject: string; category: string; at: string; status: string }>> {
    const db = need(this.deps, 'db', 'OutboxEmail');
    const { items } = await listOutbox(db, { limit });
    return items.map((r) => ({ messageId: r.message_id, to: r.to_addrs, subject: r.subject, category: r.category, at: r.created_at, status: r.status }));
  }

  /** 读取正文（/admin/outbox、/me/outbox 预览）；文件已被保留期任务删除时返回 null */
  readBody(row: Pick<OutboxEmailRow, 'eml_path'>): (ParsedEml & { raw: string }) | null {
    if (!row.eml_path) return null;
    try {
      const raw = readFileSync(this.resolveEmlPath(row.eml_path), 'utf8');
      return { ...parseEml(raw), raw };
    } catch {
      return null;
    }
  }

  async probe(_opts?: { deep?: boolean }): Promise<ProbeResult> {
    const dir = this.outboxDir;
    try {
      mkdirSync(dir, { recursive: true });
      accessSync(dir, fsConstants.W_OK);
    } catch (e) {
      return { status: 'error', detail: `outbox 目录不可写：${dir}（${(e as Error).message}）` };
    }
    let count = 0;
    try {
      count = this.deps.db ? await countOutbox(this.deps.db) : 0;
    } catch (e) {
      return { status: 'error', detail: `outbox_emails 表不可读：${(e as Error).message}` };
    }
    return {
      status: 'ok',
      detail: `邮件只写进本机 outbox（${count} 封，未真正发出）· /admin/outbox 与 /me/outbox 查看`,
      data: { dir, count, host: hostname() },
    };
  }
}
