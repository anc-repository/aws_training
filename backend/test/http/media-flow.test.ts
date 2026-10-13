// L0 照片全流程（HTTP）：完整容器 + Express 应用，真实 SQLite、真实文件系统、sharp。
// auth / secrets / identity-pool 的驱动由其他实现者负责：这里只替换它们的方法（令牌 → Principal、固定测试密钥、前缀令牌校验），
// 其余全部走本组实现的端口与路由。
import { mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeTestImage } from '@cloudalbum/image-core';
import { parsePathHeader } from '@cloudalbum/contracts';
import { asLocalMultipart } from '../../src/adapters/storage/local.js';
import { buildContainer, type Container } from '../../src/container.js';
import { createApp } from '../../src/http/app.js';
import type { Principal } from '../../src/ports/auth.js';
import type { SecretName } from '../../src/ports/secrets.js';
import { getPhoto } from '../../src/repositories/photos.js';
import { tempEnvDir } from '../helpers/config.js';
import { seedAlbum, seedUser, waitFor } from '../helpers/media-fixtures.js';

interface Env { c: Container; app: Express }

async function boot(modules: Record<string, Record<string, string>> = {}): Promise<Env> {
  const data = mkdtempSync(path.join(os.tmpdir(), 'cloudalbum-flow-'));
  const envDir = tempEnvDir({
    base: { APP_BASE_URL: 'http://localhost:3000', CLOUDALBUM_DATA_DIR: data.replace(/\\/g, '/') },
    override: { STORAGE_LOCAL_MIN_FREE_PCT: '1' },
    modules,
  });
  const c = await buildContainer('api', { envDir, processEnv: { NODE_ENV: 'test' } });
  // —— 其他实现者的驱动：只替换方法 ——
  const patch = (target: object, key: string, fn: unknown) => Object.defineProperty(target, key, { value: fn, configurable: true, writable: true });
  patch(c.secrets, 'get', async (name: SecretName) => `flow-test-${name}`);
  patch(c.auth, 'verifyAccessToken', async (token: string): Promise<Principal> => {
    const [kind, id] = token.split(':');
    return { provider: 'local', subject: id!, email: `${id}@example.com`, emailVerified: true, groups: kind === 'admin' ? ['admin'] : ['member'], plan: 'free', expiresAt: Date.now() + 3600_000 };
  });
  return { c, app: createApp(c) };
}

const auth = (userId: string, admin = false) => ({ Authorization: `Bearer ${admin ? 'admin' : 'user'}:${userId}` });
/** 路径头 → { 键: 值 }（entry、模块段） */
function pathOf(res: request.Response): Record<string, string> {
  const parsed = parsePathHeader(String(res.headers['x-cloudalbum-path'] ?? ''));
  return {
    ...(parsed.entry ? { entry: parsed.entry } : {}),
    ...Object.fromEntries(parsed.modules.map((m) => [m.module, m.raw])),
  };
}

describe('L0 照片全流程：F6 签名直传 → inline 缩略图 → 时间线 → 社交 → 分享 → 媒体 → 日报', () => {
  let env: Env;
  let owner: string;
  let other: string;
  let admin: string;
  let photoId: string;

  beforeAll(async () => {
    env = await boot();
    owner = await seedUser(env.c.db, { name: 'Owner' });
    other = await seedUser(env.c.db, { name: 'Other' });
    admin = await seedUser(env.c.db, { role: 'admin', name: 'Admin' });
    await seedAlbum(env.c.db, owner, { visibility: 'public' });
  });
  afterAll(async () => {
    await env?.c.close();
  });

  it('POST /api/photos → PUT 上传目标 → complete → READY（inline:sync）', async () => {
    const { app } = env;
    const jpeg = await makeTestImage({ width: 1200, height: 900, color: '#2040e0' });
    await request(app).post('/api/photos').send({ contentType: 'image/jpeg' }).expect(401);
    await request(app).post('/api/photos').set(auth(owner)).send({ contentType: 'image/gif' }).expect(415);
    await request(app).post('/api/photos').set(auth(owner)).send({ contentType: 'image/jpeg', size: 999 * 1024 * 1024 }).expect(413);
    const created = await request(app).post('/api/photos').set(auth(owner))
      .send({ contentType: 'image/jpeg', filename: 'sky.jpg', size: jpeg.length, title: '天空' }).expect(201);
    photoId = created.body.photoId;
    expect(created.body.photo).toMatchObject({ id: photoId, status: 'UPLOADING', visibility: 'public', title: '天空' });
    expect(created.body.uploadTarget).toMatchObject({ method: 'PUT', headers: { 'Content-Type': 'image/jpeg' } });
    expect(pathOf(created).storage).toBe('local:sign');
    const url: string = created.body.uploadTarget.url;

    // 篡改签名 → 403；Content-Type 不符 → 415
    await request(app).put(url.replace(/sig=[^&]+/, 'sig=AAAA')).set('Content-Type', 'image/jpeg').send(jpeg).expect(403);
    await request(app).put(url).set('Content-Type', 'image/png').send(jpeg).expect(415);
    await request(app).post(`/api/photos/${photoId}/complete`).set(auth(owner)).expect(409);   // 还没上传

    const put = await request(app).put(url).set('Content-Type', 'image/jpeg').send(jpeg).expect(200);
    expect(put.body).toMatchObject({ size: jpeg.length });
    expect(pathOf(put).storage).toBe('local:write');
    await request(app).put(url).set('Content-Type', 'image/jpeg').send(jpeg).expect(200);       // 幂等重试

    await request(app).post(`/api/photos/${photoId}/complete`).set(auth(other)).expect(404);   // 别人的照片
    const done = await request(app).post(`/api/photos/${photoId}/complete`).set(auth(owner)).expect(200);
    expect(done.body).toMatchObject({ status: 'READY', mode: 'sync' });
    expect(done.body.photo.urls.thumb).toBe(`/media/variants/${photoId}/thumb_200.webp`);
    expect(done.body.photo.urls.original).toMatch(new RegExp(`^/media/raw/${owner}/${photoId}\\.jpg\\?exp=\\d+&sig=`));
    const p = pathOf(done);
    expect(p['image-processing']).toBe('inline:sync');
    expect(p.workflow).toBe('inline:sync');
    expect(p.tagging).toBe('none:basic');
    expect(p.queue).toBe('sync:inline');
    // 重复 complete 幂等
    const again = await request(app).post(`/api/photos/${photoId}/complete`).set(auth(owner)).expect(200);
    expect(again.body.already).toBe(true);
  });

  it('GET /media/variants/... 返回 200 image/webp（开发机直出 local:stream；经 Nginx 时 X-Accel-Redirect local:accel）', async () => {
    const { app } = env;
    const direct = await request(app).get(`/media/variants/${photoId}/thumb_200.webp`).expect(200);
    expect(direct.headers['content-type']).toBe('image/webp');
    expect(direct.headers['cache-control']).toBe('public, max-age=86400');
    expect(pathOf(direct).storage).toBe('local:stream');
    await request(app).get(`/media/variants/${photoId}/thumb_200.webp`).set('If-None-Match', String(direct.headers.etag)).expect(304);
    // 经 Nginx：X-CloudAlbum-Entry 只信任来自回环地址的连接（监听 127.0.0.1，与 EC2 上的 HOST=127.0.0.1 相同）
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((r) => server.once('listening', () => r()));
    const { port } = server.address() as AddressInfo;
    const viaNginx = await request(`http://127.0.0.1:${port}`).get(`/media/variants/${photoId}/display_1080.webp`).set('X-CloudAlbum-Entry', 'nginx').expect(200);
    await new Promise<void>((r) => server.close(() => r()));
    expect(viaNginx.headers['x-accel-redirect']).toBe(`/_media_local/public/variants/${photoId}/display_1080.webp`);
    expect(pathOf(viaNginx)).toMatchObject({ entry: 'nginx', storage: 'local:accel' });
    await request(app).get(`/media/variants/${photoId}/nope.webp`).expect(404);
    await request(app).get('/media/variants/not-a-photo/thumb_200.webp').expect(404);
    await request(app).get('/media/../etc/passwd').expect(404);
  });

  it('私有媒体：没有签名 403，带签名 200', async () => {
    const { app, c } = env;
    const photo = (await getPhoto(c.db, photoId))!;
    await request(app).get(`/media/${photo.rawKey}`).expect(403);
    const detail = await request(app).get(`/api/photos/${photoId}`).set(auth(owner)).expect(200);
    const res = await request(app).get(detail.body.urls.original).expect(200);
    expect(res.headers['content-type']).toBe('image/jpeg');
    expect(res.headers['cache-control']).toBe('private, max-age=300');
  });

  it('照片详情、处理流程、搜索、时间线（我的 / 公开）', async () => {
    const { app } = env;
    const detail = await request(app).get(`/api/photos/${photoId}`).set(auth(owner)).expect(200);
    expect(detail.body).toMatchObject({ id: photoId, status: 'READY', width: 1200, height: 900, isOwner: true, storage: { driver: 'local' } });
    expect(detail.body.labels.map((l: { name: string }) => l.name)).toEqual(expect.arrayContaining(['orientation:landscape', 'color:blue', 'format:jpeg']));
    expect(detail.body.moderation).toMatchObject({ verdict: 'pass' });
    const anon = await request(app).get(`/api/photos/${photoId}`).expect(200);
    expect(anon.body.urls.original).toBeUndefined();
    expect(anon.body.moderation).toBeUndefined();

    const steps = await request(app).get(`/api/photos/${photoId}/pipeline`).set(auth(owner)).expect(200);
    expect(steps.body.steps.map((s: { step: string }) => s.step)).toEqual(['thumbnail', 'tag', 'decide']);

    const search = await request(app).get('/api/search').query({ tag: 'color:blue' }).expect(200);
    expect(search.body.items.map((i: { id: string }) => i.id)).toContain(photoId);
    const tags = await request(app).get('/api/search/tags').expect(200);
    expect(tags.body.items.length).toBeGreaterThan(0);

    const mine = await request(app).get('/api/feed').set(auth(owner)).expect(200);
    expect(mine.body).toMatchObject({ scope: 'mine' });
    expect(mine.body.items[0]).toMatchObject({ id: photoId, counters: { likes: 0, comments: 0 }, likedByMe: false });
    expect(mine.headers['cache-control']).toBe('private, no-store');
    expect(pathOf(mine).cache).toBe('none');
    const pub = await request(app).get('/api/feed').query({ scope: 'public' }).expect(200);
    expect(pub.body.items.map((i: { id: string }) => i.id)).toContain(photoId);
  });

  it('点赞（幂等）、评论（通知主人，F10）、删除评论', async () => {
    const { app, c } = env;
    const l1 = await request(app).post(`/social/photos/${photoId}/likes`).set(auth(other)).expect(200);
    expect(l1.body).toMatchObject({ created: true, likes: 1 });
    expect(pathOf(l1)['social-store']).toBe('db');
    const l2 = await request(app).post(`/social/photos/${photoId}/likes`).set(auth(other)).expect(200);
    expect(l2.body).toMatchObject({ created: false, likes: 1 });
    const cm = await request(app).post(`/social/photos/${photoId}/comments`).set(auth(other)).send({ text: '好看！' }).expect(201);
    expect(cm.body.comment).toMatchObject({ text: '好看！', user: { displayName: 'Other' }, mine: true });
    await request(app).post(`/social/photos/${photoId}/comments`).set(auth(other)).send({ text: '   ' }).expect(400);
    const list = await request(app).get(`/social/photos/${photoId}/comments`).expect(200);
    expect(list.body.items).toHaveLength(1);
    const counters = await request(app).get(`/social/photos/${photoId}`).set(auth(other)).expect(200);
    expect(counters.body).toEqual({ photoId, counters: { likes: 1, comments: 1 }, likedByMe: true });
    // 照片主人收到站内信
    const notes = await c.db('notifications').where({ user_id: owner }).orderBy('created_at');
    expect(notes.map((n: { type: string }) => n.type)).toEqual(['like.created', 'comment.created']);
    await request(app).delete(`/social/photos/${photoId}/comments/${cm.body.comment.id}`).set(auth(owner)).expect(403);
    await request(app).delete(`/social/photos/${photoId}/comments/${cm.body.comment.id}`).set(auth(other)).expect(204);
    const un = await request(app).delete(`/social/photos/${photoId}/likes`).set(auth(other)).expect(200);
    expect(un.body).toMatchObject({ removed: true, likes: 0 });
    expect((await request(app).get('/social/health').expect(200)).body).toMatchObject({ status: 'ok', driver: 'db' });
  });

  it('分享链接（F11）：创建 → 匿名打开 → 过期 410', async () => {
    const { app, c } = env;
    await request(app).post('/api/shares').set(auth(other)).send({ photoId }).expect(404);    // 只有主人能分享
    const s = await request(app).post('/api/shares').set(auth(owner)).send({ photoId, ttlSec: 3600 }).expect(201);
    expect(s.body.url).toBe(`http://localhost:3000/s/${s.body.token}`);
    const open = await request(app).get(`/api/shares/${s.body.token}`).expect(200);
    expect(open.body.photo).toMatchObject({ id: photoId, urls: { thumb: `/media/variants/${photoId}/thumb_200.webp` } });
    await c.db('share_links').where({ token: s.body.token }).update({ expires_at: '2020-01-01T00:00:00.000Z' });
    await request(app).get(`/api/shares/${s.body.token}`).expect(410);
    await request(app).get('/api/shares/does-not-exist').expect(410);
  });

  it('点击流：POST /api/events（服务端补 ipHash，不存原始 IP）；管理员报表', async () => {
    const { app, c } = env;
    const r = await request(app).post('/api/events').set(auth(other))
      .send({ events: [{ type: 'page_view', path: '/' }, { type: 'photo_view', path: `/photos/${photoId}`, photoId }] }).expect(202);
    expect(r.body).toEqual({ accepted: 2, dropped: 0 });
    await request(app).post('/api/events').send({ events: [{ type: 'nope' }] }).expect(400);
    await (c.analytics as unknown as { flush(): Promise<void> }).flush();
    const rows = await c.db('click_events').select('ip_hash', 'user_id');
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.every((x: { ip_hash: string }) => /^[0-9a-f]{32}$/.test(x.ip_hash))).toBe(true);
    await request(app).get('/api/events/report').set(auth(other)).expect(403);
    const rep = await request(app).get('/api/events/report').query({ groupBy: 'type' }).set(auth(admin, true)).expect(200);
    expect(rep.body).toMatchObject({ driver: 'db', mode: 'sync', groupBy: 'type' });
    expect(rep.body.rows.length).toBeGreaterThan(0);
  });

  it('日报（F13）：管理员立即生成 → reports/daily/<日期>.csv（私有，签名 URL）→ 管理员站内信', async () => {
    const { app } = env;
    await request(app).post('/api/reports/daily').set(auth(owner)).send({}).expect(403);
    const day = new Date().toISOString().slice(0, 10);
    const gen = await request(app).post('/api/reports/daily').set(auth(admin, true)).send({ day }).expect(201);
    expect(gen.body).toMatchObject({ day, key: `reports/daily/${day}.csv` });
    expect(gen.body.stats.uploads).toBeGreaterThanOrEqual(1);
    const csv = await request(app).get(gen.body.url).expect(200);
    expect(csv.text).toContain('metric,value');
    expect(csv.text).toContain(`date,${day}`);
    const list = await request(app).get('/api/reports/daily').set(auth(admin, true)).expect(200);
    expect(list.body.items[0]).toMatchObject({ day });
    const one = await request(app).get(`/api/reports/daily/${day}`).set(auth(admin, true)).expect(200);
    expect(one.body.url).toMatch(/\?exp=\d+&sig=/);
    const notes = await env.c.db('notifications').where({ user_id: admin, type: 'report.ready' });
    expect(notes).toHaveLength(1);
  });

  it('修改与删除：PATCH 改可见性后公开时间线不再出现；DELETE 后媒体 404', async () => {
    const { app } = env;
    const patched = await request(app).patch(`/api/photos/${photoId}`).set(auth(owner)).send({ visibility: 'private', title: '新标题' }).expect(200);
    expect(patched.body).toMatchObject({ visibility: 'private', title: '新标题' });
    const pub = await request(app).get('/api/feed').query({ scope: 'public' }).expect(200);
    expect(pub.body.items.map((i: { id: string }) => i.id)).not.toContain(photoId);
    await request(app).get(`/api/photos/${photoId}`).expect(404);                  // 私有：匿名看不到
    await request(app).delete(`/api/photos/${photoId}`).set(auth(other)).expect(404);
    await request(app).delete(`/api/photos/${photoId}`).set(auth(owner)).expect(204);
    await request(app).get(`/media/variants/${photoId}/thumb_200.webp`).expect(404);
  });

  it('文件头不是图片：complete 返回 415，照片 FAILED，原图被删除', async () => {
    const { app, c } = env;
    const created = await request(app).post('/api/photos').set(auth(owner)).send({ contentType: 'image/png' }).expect(201);
    await request(app).put(created.body.uploadTarget.url).set('Content-Type', 'image/png').send(Buffer.from('this is not a png file at all')).expect(200);
    const r = await request(app).post(`/api/photos/${created.body.photoId}/complete`).set(auth(owner)).expect(415);
    expect(r.body.error).toBe('UNSUPPORTED_MEDIA_TYPE');
    const photo = (await getPhoto(c.db, created.body.photoId))!;
    expect(photo.status).toBe('FAILED');
    expect(await c.storage.headObject(photo.rawKey)).toBeNull();
  });

  it('F14 本地前缀令牌：分两片 PUT（Authorization: CA-Upload）→ 查询已收到的分片 → complete', async () => {
    const { app, c } = env;
    // identity-pool 的 none 驱动由其他实现者负责：这里按约定替换 authorizePart / complete
    const patch = (key: string, fn: unknown) => Object.defineProperty(c.directUpload, key, { value: fn, configurable: true, writable: true });
    patch('authorizePart', async (token: string, key: string) => {
      const prefix = `raw/${token.replace(/^tok-/, '')}/`;
      if (!key.startsWith(prefix)) throw Object.assign(new Error('前缀不符'), { status: 403 });
      return {};
    });
    patch('complete', async (pid: string) => {
      const photo = (await getPhoto(c.db, pid))!;
      const r = await asLocalMultipart(c.storage)!.completeParts(`up-${pid}`, photo.rawKey, { maxBytes: 30 * 1024 * 1024 });
      return r.ok ? { ok: true, rawKey: photo.rawKey } : { ok: false, reason: r.reason };
    });
    const jpeg = await makeTestImage({ width: 640, height: 480 });
    const created = await request(app).post('/api/photos').set(auth(owner)).send({ contentType: 'image/jpeg' }).expect(201);
    const pid: string = created.body.photoId;
    const key = `raw/${owner}/${pid}.jpg`;
    const uploadId = `up-${pid}`;
    const half = Math.floor(jpeg.length / 2);
    const put = (part: number, body: Buffer, token = `tok-${owner}`) => request(app).put('/api/storage/upload')
      .query({ key, uploadId, part }).set('Authorization', `CA-Upload ${token}`).set('Content-Type', 'application/octet-stream').send(body);
    await request(app).put('/api/storage/upload').query({ key, uploadId, part: 1 }).send(jpeg.subarray(0, half)).expect(401);
    await put(1, jpeg.subarray(0, half), `tok-${other}`).expect(403);              // 写别人的前缀
    const p1 = await put(1, jpeg.subarray(0, half)).expect(200);
    expect(pathOf(p1).storage).toBe('local:part');
    const parts = await request(app).get('/api/storage/upload/parts').query({ key, uploadId }).set('Authorization', `CA-Upload tok-${owner}`).expect(200);
    expect(parts.body.parts.map((p: { part: number }) => p.part)).toEqual([1]);
    await put(2, jpeg.subarray(half)).expect(200);
    const done = await request(app).post(`/api/photos/${pid}/complete`).set(auth(owner)).expect(200);
    expect(done.body.status).toBe('READY');
    const signed = await request(app).post('/api/uploads/parts:sign').set('Authorization', `CA-Upload tok-${owner}`).send({ key, uploadId, part: 3 }).expect(200);
    expect(signed.body.url).toContain('/api/storage/upload?');
  });

  it('api 进程登记了定时任务：管理员“立即运行”（SchedulerPort.triggerNow）可用', async () => {
    const r = await request(env.app).post('/api/admin/jobs/share.cleanup/run').set(auth(admin, true)).expect(200);
    expect(r.body).toMatchObject({ name: 'share.cleanup', status: 'ok', trigger: 'manual' });
  });

  it('/internal/hooks/image-processed 在 inline 档返回 404；/api/uploads/credentials 在 none 档 404', async () => {
    await request(env.app).post('/internal/hooks/image-processed').send({}).expect(404);
    await request(env.app).get('/api/uploads/credentials').set(auth(owner)).expect(404);
  });
});

describe('本地档：cache=memory（时间线 cache-aside + 管理员旁路）', () => {
  let env: Env;
  let owner: string;
  let admin: string;
  beforeAll(async () => {
    env = await boot({ cache: { CACHE_DRIVER: 'memory' } });
    owner = await seedUser(env.c.db);
    admin = await seedUser(env.c.db, { role: 'admin' });
  });
  afterAll(async () => {
    await env?.c.close();
  });

  it('第二次 GET /api/feed 命中；上传后版本号失效；X-Compare-Bypass: cache → memory:bypass', async () => {
    const { app } = env;
    const r1 = await request(app).get('/api/feed').set(auth(owner)).expect(200);
    expect(pathOf(r1).cache).toBe('memory:miss');
    const r2 = await request(app).get('/api/feed').set(auth(owner)).expect(200);
    expect(pathOf(r2).cache).toBe('memory:hit');
    await request(app).post('/api/photos').set(auth(owner)).send({ contentType: 'image/jpeg' }).expect(201);
    const r3 = await request(app).get('/api/feed').set(auth(owner)).expect(200);
    expect(pathOf(r3).cache).toBe('memory:miss');
    expect(r3.body.items).toHaveLength(1);
    await request(app).get('/api/feed').set(auth(owner)).set('X-Compare-Bypass', 'cache').expect(403);   // 非管理员
    const b = await request(app).get('/api/feed').query({ scope: 'public' }).set(auth(admin, true)).set('X-Compare-Bypass', 'cache').expect(200);
    expect(pathOf(b).cache).toBe('memory:bypass');
    expect(b.headers['x-cloudalbum-bypass']).toBe('cache');
  });
});

describe('本地档：image-processing=worker + queue=memory（api 进程内后台生成缩略图）', () => {
  let env: Env;
  let owner: string;
  beforeAll(async () => {
    env = await boot({ queue: { QUEUE_DRIVER: 'memory' }, 'image-processing': { IMAGE_PROCESSOR: 'worker' } });
    owner = await seedUser(env.c.db);
  });
  afterAll(async () => {
    await env?.c.close();
  });

  it('complete 立即返回 202（worker:async、memory:queued），随后后台处理为 READY', async () => {
    const { app, c } = env;
    const jpeg = await makeTestImage({ width: 500, height: 500 });
    const created = await request(app).post('/api/photos').set(auth(owner)).send({ contentType: 'image/jpeg' }).expect(201);
    await request(app).put(created.body.uploadTarget.url).set('Content-Type', 'image/jpeg').send(jpeg).expect(200);
    const r = await request(app).post(`/api/photos/${created.body.photoId}/complete`).set(auth(owner)).expect(202);
    expect(r.body).toMatchObject({ status: 'PROCESSING', mode: 'async' });
    expect(pathOf(r)).toMatchObject({ 'image-processing': 'worker:async', queue: 'memory:queued', workflow: 'inline:async' });
    const photo = await waitFor(async () => {
      const p = await getPhoto(c.db, created.body.photoId);
      return p?.status === 'READY' && p.labels.length ? p : null;
    });
    expect(photo.processedBy).toMatchObject({ driver: 'worker' });
  });
});
