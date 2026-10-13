// backend/src/adapters/auth/local/emails.ts —— auth=local 发出的邮件（验证邮箱、重置密码）
//
// 只生成 EmailMessage（subject / text / html），由 EmailPort 发送：outbox 档写入本机 outbox（/admin/outbox、/me/outbox 可见），
// ses 档真正发出。链接指向前端页面（/verify、/reset），由页面再调用 POST /api/auth/confirm、/api/auth/reset。
import type { EmailMessage } from '../../../ports/email.js';

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}

function link(baseUrl: string, page: string, params: Record<string, string>): string {
  const u = new URL(page, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}

function layout(title: string, body: string): string {
  return [
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>', escapeHtml(title), '</title></head>',
    '<body style="font-family:system-ui,sans-serif;line-height:1.6;color:#222">', body,
    '<hr><p style="color:#888;font-size:12px">CloudAlbum · 这是一封系统邮件，请勿直接回复。</p></body></html>',
  ].join('');
}

export function verificationEmail(input: { to: string; displayName: string; code: string; baseUrl: string; ttlHours: number }): EmailMessage {
  const url = link(input.baseUrl, 'verify', { email: input.to, code: input.code });
  const subject = 'CloudAlbum：请验证你的邮箱';
  const text = [
    `${input.displayName}，你好：`,
    '',
    '感谢注册 CloudAlbum。请打开下面的链接完成邮箱验证：',
    url,
    '',
    `或者在验证页面输入验证码：${input.code}`,
    `链接与验证码 ${input.ttlHours} 小时内有效。如果不是你本人注册，请忽略这封邮件。`,
  ].join('\n');
  const html = layout(subject, [
    `<p>${escapeHtml(input.displayName)}，你好：</p>`,
    '<p>感谢注册 CloudAlbum。请点击下面的链接完成邮箱验证：</p>',
    `<p><a href="${escapeHtml(url)}">${escapeHtml(url)}</a></p>`,
    `<p>或者在验证页面输入验证码：<code>${escapeHtml(input.code)}</code></p>`,
    `<p>链接与验证码 ${input.ttlHours} 小时内有效。如果不是你本人注册，请忽略这封邮件。</p>`,
  ].join(''));
  return { to: [input.to], subject, text, html, category: 'verification', tags: { flow: 'register' } };
}

export function passwordResetEmail(input: { to: string; displayName: string; code: string; baseUrl: string; ttlMinutes: number }): EmailMessage {
  const url = link(input.baseUrl, 'reset', { email: input.to, code: input.code });
  const subject = 'CloudAlbum：重置密码';
  const text = [
    `${input.displayName}，你好：`,
    '',
    '我们收到了重置 CloudAlbum 密码的请求。请打开下面的链接设置新密码：',
    url,
    '',
    `或者在重置页面输入验证码：${input.code}（${input.ttlMinutes} 分钟内有效）`,
    '如果不是你本人操作，请忽略这封邮件，你的密码不会改变。',
  ].join('\n');
  const html = layout(subject, [
    `<p>${escapeHtml(input.displayName)}，你好：</p>`,
    '<p>我们收到了重置 CloudAlbum 密码的请求。请点击下面的链接设置新密码：</p>',
    `<p><a href="${escapeHtml(url)}">${escapeHtml(url)}</a></p>`,
    `<p>或者在重置页面输入验证码：<code>${escapeHtml(input.code)}</code>（${input.ttlMinutes} 分钟内有效）</p>`,
    '<p>如果不是你本人操作，请忽略这封邮件，你的密码不会改变。</p>',
  ].join(''));
  return { to: [input.to], subject, text, html, category: 'password-reset', tags: { flow: 'forgot' } };
}
