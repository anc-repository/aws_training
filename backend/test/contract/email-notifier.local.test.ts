// EmailPort · outbox 与 NotifierPort · db：契约 + .eml 文件与 MIME、收件人归属、逐个发信
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildMime, OutboxEmail, parseEml } from '../../src/adapters/email/outbox.js';
import { DbNotifier } from '../../src/adapters/notification/db.js';
import { createUserWithDefaults } from '../../src/services/user-directory.js';
import { describeEmailContract, describeNotifierContract } from './email-notifier.contract.js';
import { makeLocalDeps, type LocalDeps } from './_local-deps.js';

describeEmailContract('outbox', async () => {
  const l = await makeLocalDeps();
  return { port: new OutboxEmail(l.deps), cleanup: () => l.close() };
});

describeNotifierContract('db', async () => {
  const l = await makeLocalDeps();
  l.deps.email = new OutboxEmail(l.deps);
  const u = await createUserWithDefaults(l.db, { email: 'n@example.com', displayName: 'n', passwordHash: null, emailVerified: true });
  return { port: new DbNotifier(l.deps), userId: u.id, email: u.email, cleanup: () => l.close() };
});

describe('OutboxEmail（本地实现特有）', () => {
  let l: LocalDeps | undefined;
  afterEach(async () => {
    await l?.close();
    l = undefined;
  });

  it('写 OUTBOX_DIR/<yyyy-mm-dd>/<messageId>.eml（RFC 822）；eml_path 只存相对路径；收件人是本站用户时记 user_id；delivered=false', async () => {
    l = await makeLocalDeps();
    const u = await createUserWithDefaults(l.db, { email: 'eve@example.com', displayName: 'eve', passwordHash: null });
    const port = new OutboxEmail(l.deps);
    const r = await port.send({ to: ['Eve@Example.com'], subject: '你好，世界', text: '第一行\n第二行', html: '<b>粗体</b>', category: 'notification' });
    expect(r).toMatchObject({ transport: 'outbox', delivered: false });
    const row = await l.db('outbox_emails').where({ message_id: r.messageId }).first();
    expect(row).toMatchObject({ user_id: u.id, status: 'sent', transport: 'outbox', delivery_status: 'none' });
    expect(row.eml_path).toMatch(/^\d{4}-\d{2}-\d{2}\/[0-9A-Z]{26}\.eml$/);
    const file = path.join(l.deps.cfg.email.OUTBOX_DIR, ...String(row.eml_path).split('/'));
    expect(existsSync(file)).toBe(true);
    const raw = readFileSync(file, 'utf8');
    expect(raw).toMatch(/^From: CloudAlbum <no-reply@cloudalbum.local>\r\n/);
    expect(raw).toContain('Subject: =?UTF-8?B?');
    expect(raw).toContain('X-CloudAlbum-Transport: outbox');
    const parsed = port.readBody(row)!;
    expect(parsed.subject).toBe('你好，世界');
    expect(parsed.text).toBe('第一行\n第二行');
    expect(parsed.html).toBe('<b>粗体</b>');
    expect(port.readBody({ eml_path: '../../etc/passwd' })).toBeNull();
    expect((await port.probe()).status).toBe('ok');
  });

  it('buildMime / parseEml：纯文本邮件与标签头', () => {
    const mime = buildMime({ from: 'a@b.c', messageId: 'X1', to: ['x@y.z'], subject: 'plain', text: 'hi', category: 'system', tags: { flow: 'test' } });
    expect(mime).toContain('X-CloudAlbum-Tag-flow: test');
    expect(mime).not.toContain('multipart');
    expect(parseEml(mime)).toMatchObject({ subject: 'plain', text: 'hi', html: null });
  });
});

describe('DbNotifier（本地实现特有）', () => {
  let l: LocalDeps | undefined;
  afterEach(async () => {
    await l?.close();
    l = undefined;
  });

  it('未开启邮件通知 → channels=[]；开启后 → [email] 并写 outbox 与投递记录；管理员广播逐个发信', async () => {
    l = await makeLocalDeps();
    l.deps.email = new OutboxEmail(l.deps);
    const port = new DbNotifier(l.deps);
    const u = await createUserWithDefaults(l.db, { email: 'u@example.com', displayName: 'u', passwordHash: null, emailVerified: true });
    for (const n of [1, 2]) await createUserWithDefaults(l.db, { email: `admin${n}@example.com`, displayName: 'a', passwordHash: null, role: 'admin' });
    const base = { type: 'comment.created' as const, audience: 'user' as const, origin: 'ec2' as const, recipientUserId: u.id, title: 't', body: 'b' };
    expect((await port.publish({ ...base, eventId: 'e1' })).channels).toEqual([]);
    await port.subscribeEmail(u.id, u.email);
    expect((await port.publish({ ...base, eventId: 'e2', link: '/photos/1' })).channels).toEqual(['email']);
    const mail = await l.db('outbox_emails').where({ user_id: u.id }).first();
    expect(new OutboxEmail(l.deps).readBody(mail)?.text).toContain('http://localhost:3000/photos/1');
    expect(await l.db('notification_deliveries').where({ event_id: 'e2' })).toHaveLength(1);
    const admin = await port.publish({ ...base, eventId: 'e3', audience: 'admin', recipientUserId: '', type: 'report.ready' });
    expect(admin.channels).toEqual(['email']);
    expect(await l.db('outbox_emails').where({ category: 'report' })).toHaveLength(2);
    expect((await port.probe()).detail).toContain('1 人开启了邮件通知');
  });
});
