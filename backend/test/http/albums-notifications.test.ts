// 相册（F5）与站内信 / 通知设置（F10）的 HTTP 接口
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { parsePathHeader } from '@cloudalbum/contracts';
import { nowIso } from '../../src/db/dialect.js';
import { notify, notifyFanoutHandler } from '../../src/services/notifications.js';
import { createUserWithDefaults } from '../../src/services/user-directory.js';
import { makeHarness, type Harness } from '../helpers/identity-harness.js';
import { hashPassword } from '../../src/adapters/auth/local/hash.js';

let h: Harness;
const PASSWORD = 'Correct-horse-42';

async function verifiedAgent(email: string, role: 'admin' | 'member' = 'member') {
  await createUserWithDefaults(h.c.db, { email, displayName: email.split('@')[0]!, passwordHash: await hashPassword(PASSWORD), emailVerified: true, role });
  const agent = request.agent(h.app);
  const res = await agent.post('/api/auth/login').send({ email, password: PASSWORD }).expect(200);
  return { agent, userId: res.body.user.id as string };
}

beforeAll(async () => {
  h = await makeHarness();
});

afterAll(async () => {
  await h?.close();
});

describe('相册', () => {
  it('创建 / 列表 / 详情 / 修改 / 删除；非本人只能看公开相册', async () => {
    const carol = await verifiedAgent('carol@example.com');
    const dave = await verifiedAgent('dave@example.com');
    const created = await carol.agent.post('/api/albums').send({ title: '旅行', visibility: 'private' }).expect(201);
    expect(created.body).toMatchObject({ title: '旅行', visibility: 'private', isDefault: false, photoCount: 0, ownerId: carol.userId });
    const id = created.body.id as string;

    const list = await carol.agent.get('/api/albums').expect(200);
    expect(list.body.items.map((a: { title: string }) => a.title)).toEqual(['默认相册', '旅行']);   // 默认相册在前
    expect(list.body.nextCursor).toBeNull();

    // 别人：私有相册 404；公开后可见
    await dave.agent.get(`/api/albums/${id}`).expect(404);
    await dave.agent.patch(`/api/albums/${id}`).send({ title: 'hack' }).expect(403);
    await carol.agent.patch(`/api/albums/${id}`).send({ visibility: 'public', description: '2026 秋' }).expect(200);
    const seen = await dave.agent.get(`/api/albums/${id}`).expect(200);
    expect(seen.body.album).toMatchObject({ id, visibility: 'public', description: '2026 秋' });
    expect(seen.body.photos).toEqual([]);
    const pub = await dave.agent.get(`/api/albums?userId=${carol.userId}`).expect(200);
    expect(pub.body.items.map((a: { id: string }) => a.id)).toEqual([id]);

    // 默认相册不能删除；普通相册删除后照片保留（album_id 置空）
    const def = list.body.items.find((a: { isDefault: boolean }) => a.isDefault);
    await carol.agent.delete(`/api/albums/${def.id}`).expect(409);
    const now = nowIso();
    await h.c.db('photos').insert({ id: 'p-1', owner_id: carol.userId, album_id: id, raw_key: `raw/${carol.userId}/p-1.jpg`, filename: 'a.jpg',
      content_type: 'image/jpeg', status: 'READY', visibility: 'public', thumb_key: 'variants/p-1/thumb_200.webp', created_at: now, updated_at: now });
    const withPhoto = await dave.agent.get(`/api/albums/${id}`).expect(200);
    expect(withPhoto.body.photos).toHaveLength(1);
    expect(withPhoto.body.photos[0].urls.thumb).toContain('variants/p-1/thumb_200.webp');
    expect(withPhoto.body.photos[0].urls.original).toBeNull();          // 原图只给本人
    expect(withPhoto.body.album.coverPhotoId).toBe('p-1');
    await carol.agent.delete(`/api/albums/${id}`).expect(204);
    expect((await h.c.db('photos').where({ id: 'p-1' }).first()).album_id).toBeNull();

    const audit = await h.c.db('audit_log').whereIn('action', ['album.create', 'album.update', 'album.delete']).select('action');
    expect(audit.map((r: { action: string }) => r.action).sort()).toEqual(['album.create', 'album.delete', 'album.update']);
  });

  it('列表走 cache-aside：第二次命中缓存；写操作使缓存失效；管理员可用 X-Compare-Bypass: cache', async () => {
    const erin = await verifiedAgent('erin@example.com', 'admin');
    const first = await erin.agent.get('/api/albums').expect(200);
    expect(parsePathHeader(first.headers['x-cloudalbum-path']).modules.find((s) => s.module === 'cache')?.raw).toBe('memory:miss');
    const second = await erin.agent.get('/api/albums').expect(200);
    expect(parsePathHeader(second.headers['x-cloudalbum-path']).modules.find((s) => s.module === 'cache')?.raw).toBe('memory:hit');
    await erin.agent.post('/api/albums').send({ title: '新相册' }).expect(201);
    const third = await erin.agent.get('/api/albums').expect(200);
    expect(third.body.items).toHaveLength(2);
    const bypass = await erin.agent.get('/api/albums').set('X-Compare-Bypass', 'cache').expect(200);
    expect(bypass.headers['x-cloudalbum-bypass']).toBe('cache');
    expect(parsePathHeader(bypass.headers['x-cloudalbum-path']).modules.find((s) => s.module === 'cache')?.raw).toBe('memory:bypass');
    const audited = await h.c.db('audit_log').where({ action: 'lab.bypass' }).first();
    expect(audited).toBeTruthy();
  });

  it('输入校验：空标题 400；未登录 401', async () => {
    const f = await verifiedAgent('frank@example.com');
    const r = await f.agent.post('/api/albums').send({ title: '' }).expect(400);
    expect(r.body.error).toBe('VALIDATION_FAILED');
    await request(h.app).post('/api/albums').send({ title: 'x' }).expect(401);
    await request(h.app).get('/api/albums').expect(401);
  });
});

describe('站内信与通知设置', () => {
  it('notify() 写站内信（幂等）并经 notify.fanout 扇出；未开启邮件通知时不发邮件', async () => {
    const g = await verifiedAgent('grace@example.com');
    h.queue.bind({ 'notify.fanout': notifyFanoutHandler({ notifier: h.c.notifier, logger: h.c.logger }) });
    const deps = { db: h.c.db, notifier: h.c.notifier, queue: h.c.queue, logger: h.c.logger };
    const evt = { eventId: 'evt-1', type: 'comment.created' as const, audience: 'user' as const, recipientUserId: g.userId, title: '新评论', body: '有人评论了你的照片', link: '/photos/p-1' };
    expect((await notify(deps, evt)).created).toBe(1);
    expect((await notify(deps, evt)).created).toBe(0);                 // 同一事件重复到达
    expect(h.queue.enqueued.filter((j) => j.name === 'notify.fanout')).toHaveLength(1);

    const unread = await g.agent.get('/api/notifications/unread-count').expect(200);
    expect(unread.body.count).toBe(1);
    const list = await g.agent.get('/api/notifications').expect(200);
    expect(list.body.items[0]).toMatchObject({ type: 'comment.created', title: '新评论', link: '/photos/p-1', readAt: null });
    expect(await h.c.db('notification_deliveries').where({ event_id: 'evt-1' }).count({ n: '*' }).first()).toMatchObject({ n: 0 });

    await g.agent.post(`/api/notifications/${list.body.items[0].id}/read`).expect(204);
    expect((await g.agent.get('/api/notifications/unread-count')).body.count).toBe(0);
    await g.agent.post('/api/notifications/nope/read').expect(404);
  });

  it('打开邮件通知后，同类事件经 EmailPort 写入 outbox（notification=db:email），并记录投递', async () => {
    const i = await verifiedAgent('ivan@example.com');
    const prefs = await i.agent.put('/api/notifications/prefs').send({ emailEnabled: true }).expect(200);
    expect(prefs.body).toMatchObject({ emailEnabled: true, driver: 'db', pendingConfirmation: false });
    const deps = { db: h.c.db, notifier: h.c.notifier, queue: h.c.queue, logger: h.c.logger };
    await notify(deps, { eventId: 'evt-2', type: 'like.created', audience: 'user', recipientUserId: i.userId, title: '有人点赞', body: '你的照片收到一个赞' });
    const mail = await h.c.db('outbox_emails').where({ user_id: i.userId, category: 'notification' }).first();
    expect(mail.subject).toBe('有人点赞');
    const deliveries = await h.c.db('notification_deliveries').where({ event_id: 'evt-2' });
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({ channel: 'email', status: 'stored', target: 'ivan@example.com' });
    // 至少一次投递：同一事件再次扇出不会重复发信
    await h.c.notifier.publish({ eventId: 'evt-2', type: 'like.created', audience: 'user', origin: 'ec2', recipientUserId: i.userId, title: 'x', body: 'y' });
    expect(await h.c.db('outbox_emails').where({ user_id: i.userId, category: 'notification' }).count({ n: '*' }).first()).toMatchObject({ n: 1 });

    await i.agent.put('/api/notifications/prefs').send({ emailEnabled: false }).expect(200);
    expect((await i.agent.get('/api/notifications/prefs')).body.emailEnabled).toBe(false);
  });

  it('管理员广播：每个管理员一条站内信、逐个发邮件', async () => {
    const deps = { db: h.c.db, notifier: h.c.notifier, queue: h.c.queue, logger: h.c.logger };
    const admins = await h.c.db('users').where({ role: 'admin' }).select('id');
    const r = await notify(deps, { eventId: 'evt-3', type: 'report.ready', audience: 'admin', recipientUserId: '', title: '日报已生成', body: '见附件' });
    expect(r.created).toBe(admins.length);
    const mails = await h.c.db('outbox_emails').where({ category: 'report' });
    expect(mails).toHaveLength(admins.length);
  });

  it('read-all', async () => {
    const j = await verifiedAgent('judy@example.com');
    const deps = { db: h.c.db, notifier: h.c.notifier, queue: h.c.queue, logger: h.c.logger };
    for (const n of [1, 2, 3]) {
      await notify(deps, { eventId: `evt-j-${n}`, type: 'comment.created', audience: 'user', recipientUserId: j.userId, title: `t${n}`, body: 'b' });
    }
    const page1 = await j.agent.get('/api/notifications?limit=2').expect(200);
    expect(page1.body.items).toHaveLength(2);
    expect(page1.body.nextCursor).toBeTruthy();
    const page2 = await j.agent.get(`/api/notifications?limit=2&cursor=${page1.body.nextCursor}`).expect(200);
    expect(page2.body.items).toHaveLength(1);
    expect((await j.agent.post('/api/notifications/read-all').expect(200)).body.updated).toBe(3);
  });
});
