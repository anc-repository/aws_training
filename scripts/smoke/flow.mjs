// scripts/smoke/flow.mjs —— 相册全流程（总纲 §2.9 冒烟测试的应用部分），各档位共用
//
// 注册 → 在 /me/outbox 找到验证邮件并完成验证 → 登录 → 建相册 → 申请上传目标并上传真实 JPEG（F6）→ 缩略图生成且可访问 →
// 时间线 → 另一个用户点赞与评论 → 通知 → 分享链接 → 日报（手动触发）→ /api/capabilities → 可观测性头 → 管理员旁路。
// 期望值由 profile 描述（驱动、上传方式、缩略图是否异步、缓存档），同一份流程跑 L0、本地档、自建档与 LocalStack 档。
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { check, Client, cli, expectStatus, sleep } from './lib.mjs';

/** 一张“真实”的 JPEG：渐变 + 噪点 + EXIF（拍摄时间、相机），1600×1200 */
export async function realJpeg() {
  const width = 1600;
  const height = 1200;
  const raw = Buffer.alloc(width * height * 3);
  let seed = 42;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      const n = rnd() * 30;
      raw[i] = Math.min(255, (x / width) * 200 + n);
      raw[i + 1] = Math.min(255, (y / height) * 180 + n);
      raw[i + 2] = Math.min(255, 120 + Math.sin((x + y) / 60) * 60 + n);
    }
  }
  return sharp(raw, { raw: { width, height, channels: 3 } })
    .withExif({ IFD0: { Make: 'CloudAlbum', Model: 'SmokeCam 1', DateTime: '2026:09:30 10:20:30' }, IFD2: { DateTimeOriginal: '2026:09:30 10:20:30' } })
    .jpeg({ quality: 85 })
    .toBuffer();
}

function pathHeader(res) {
  return res.headers.get('x-cloudalbum-path') ?? '';
}

function segments(res) {
  const out = {};
  for (const part of pathHeader(res).split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

async function registerAndVerify(base, label, password) {
  const c = new Client(base, label);
  const email = `${label}-${randomUUID().slice(0, 8)}@smoke.test`;
  const reg = expectStatus(await c.post('/api/auth/register', { email, password, displayName: label }), 201);
  check(reg.body.needsConfirmation === true, `注册后应需要验证邮箱：${JSON.stringify(reg.body)}`);
  check(reg.body.restrictedSession === true, '注册后应得到“未验证”的受限会话');
  // 受限会话：/api/feed 应被拒（403 EMAIL_NOT_VERIFIED），/api/me 可读
  const blocked = await c.get('/api/feed?scope=mine');
  check(blocked.status === 403 && blocked.body?.error === 'EMAIL_NOT_VERIFIED', `未验证时 /api/feed 应为 403 EMAIL_NOT_VERIFIED，实际 ${blocked.status}`);
  const me0 = expectStatus(await c.get('/api/me'), 200);
  check(me0.body.restricted === true && me0.body.email === email, `/api/me 应返回受限的本人：${JSON.stringify(me0.body)}`);
  // outbox 中的验证邮件（等写入）
  let mail;
  for (let i = 0; i < 20 && !mail; i++) {
    const list = expectStatus(await c.get('/api/me/outbox'), 200);
    mail = list.body.items.find((m) => /verif|验证/i.test(`${m.category} ${m.subject}`));
    if (!mail) await sleep(200);
  }
  check(mail, '在 /api/me/outbox 中没有找到验证邮件');
  const detail = expectStatus(await c.get(`/api/me/outbox/${mail.id}`), 200);
  const link = (detail.body.links ?? []).find((l) => l.includes('/verify')) ?? (detail.body.text ?? '').match(/https?:\/\/\S*\/verify\?\S+/)?.[0];
  check(link, `验证邮件中没有 /verify 链接：${JSON.stringify(detail.body).slice(0, 300)}`);
  const u = new URL(link);
  const code = u.searchParams.get('code');
  check(code && u.searchParams.get('email')?.toLowerCase() === email.toLowerCase(), `验证链接参数不完整：${link}`);
  expectStatus(await c.post('/api/auth/confirm', { email, code }), 200);
  return { client: c, email, outboxMail: mail };
}

async function login(base, label, email, password) {
  const c = new Client(base, label);
  const r = expectStatus(await c.post('/api/auth/login', { email, password }), 200);
  check(r.body.kind === 'tokens', `登录应直接得到令牌：${JSON.stringify(r.body)}`);
  check(c.jar.size > 0, '登录应设置会话 Cookie');
  return { client: c, user: r.body.user };
}

/**
 * profile：{
 *   name, storage: 'local'|'s3', imageAsync: boolean, imageDriver, queueDriver, cacheDriver, dbDriver, authDriver: 'local',
 *   expectModules: { <模块>: { driver, status? } }
 * }
 */
export async function runFlow(t, env, profile) {
  const base = env.baseUrl;
  const password = `Smoke-${randomUUID().slice(0, 8)}-pw!`;
  const s = {};

  t.section(`${profile.name}：账号`);
  await t.step('健康检查 /api/health/live 与 /api/health/ready', async () => {
    const anon = new Client(base);
    expectStatus(await anon.get('/api/health/live'), 200);
    const r = expectStatus(await anon.get('/api/health/ready'), 200);
    return `ready=${r.body.status ?? 'ok'}`;
  });
  await t.step('注册 → /me/outbox 找到验证邮件 → 完成验证（用户 A）', async () => {
    const a = await registerAndVerify(base, 'alice', password);
    s.aEmail = a.email;
    return `${a.email} · 邮件「${a.outboxMail.subject}」`;
  });
  await t.step('登录（用户 A）；/api/me 不再受限', async () => {
    const r = await login(base, 'alice', s.aEmail, password);
    s.a = r.client;
    s.aId = r.user.id;
    const me = expectStatus(await s.a.get('/api/me'), 200);
    check(me.body.emailVerified === true && me.body.restricted === false, `验证后 /api/me 应为已验证：${JSON.stringify(me.body)}`);
    return `userId=${s.aId}`;
  });
  await t.step('注册并验证、登录用户 B（点赞评论用）', async () => {
    const b = await registerAndVerify(base, 'bob', password);
    const r = await login(base, 'bob', b.email, password);
    s.b = r.client;
    s.bId = r.user.id;
    return b.email;
  });
  await t.step('管理员（cli admin:create）登录', async () => {
    const email = `admin-${randomUUID().slice(0, 6)}@smoke.test`;
    const adminPw = `Admin-${randomUUID().slice(0, 8)}!`;
    const r = cli(env.etc, ['admin:create', '--email', email, '--password', adminPw]);
    check(r.status === 0, `admin:create 失败（${r.status}）：${r.stderr || r.stdout}`);
    const l = await login(base, 'admin', email, adminPw);
    s.admin = l.client;
    check(l.user.role === 'admin', '管理员登录后 role 应为 admin');
    return email;
  });

  t.section(`${profile.name}：相册与上传`);
  await t.step('创建公开相册', async () => {
    const r = expectStatus(await s.a.post('/api/albums', { title: `Smoke ${profile.name}`, visibility: 'public' }), 201);
    s.albumId = r.body.id ?? r.body.album?.id;
    check(s.albumId, `建相册响应没有 id：${JSON.stringify(r.body)}`);
    return `albumId=${s.albumId}`;
  });
  await t.step(`申请上传目标并 PUT 一张真实 JPEG（${profile.storage === 's3' ? 'S3 预签名 URL' : '本地 HMAC 签名 URL'}）`, async () => {
    s.jpeg = await realJpeg();
    const r = expectStatus(await s.a.post('/api/photos', {
      contentType: 'image/jpeg', filename: 'smoke.jpg', size: s.jpeg.length, albumId: s.albumId, title: 'smoke photo',
    }), 201);
    s.photoId = r.body.photoId;
    const target = r.body.uploadTarget;
    check(target?.url && target.method === 'PUT', `上传目标不完整：${JSON.stringify(r.body).slice(0, 300)}`);
    if (profile.storage === 's3') check(/^https?:\/\//.test(target.url) && /X-Amz-Signature=/.test(target.url), `s3 档应返回预签名 URL：${target.url}`);
    else check(target.url.startsWith('/api/storage/upload?'), `local 档应返回本站签名 URL：${target.url}`);
    const put = await s.a.req('PUT', target.url, { body: s.jpeg, headers: { ...(target.headers ?? {}) } });
    check(put.status === 200, `PUT 上传失败：${put.status} ${typeof put.body === 'string' ? put.body.slice(0, 300) : JSON.stringify(put.body)}`);
    return `${s.jpeg.length} 字节 → ${target.url.split('?')[0]}`;
  });
  await t.step(`complete → ${profile.imageAsync ? '202 PROCESSING，轮询到 READY' : '200 READY（inline）'}`, async () => {
    const r = expectStatus(await s.a.post(`/api/photos/${s.photoId}/complete`, {}), profile.imageAsync ? 202 : 200, profile.imageAsync ? 200 : 200);
    const seg = segments(r);
    s.completePath = pathHeader(r);
    if (!profile.imageAsync) check(r.body.status === 'READY', `inline 档 complete 后应为 READY：${r.body.status}`);
    const t0 = Date.now();
    let photo = r.body.photo;
    while (photo.status !== 'READY') {
      check(photo.status !== 'FAILED', `缩略图处理失败：${photo.failureReason ?? ''}`);
      check(Date.now() - t0 < 60_000, `等待 READY 超时（当前 ${photo.status}）`);
      await sleep(300);
      photo = expectStatus(await s.a.get(`/api/photos/${s.photoId}`), 200).body;
    }
    s.photo = photo;
    return `image-processing=${seg['image-processing'] ?? '?'} · ${r.status} · READY 用时 ${Date.now() - t0}ms · processedBy=${photo.processedBy?.driver ?? '?'}`;
  });
  await t.step('缩略图与展示图可访问（WebP，宽 200 / ≤1080）', async () => {
    const p = s.photo;
    check(p.urls?.thumb && p.urls?.display, `READY 照片应有 urls.thumb / urls.display：${JSON.stringify(p.urls)}`);
    if (profile.imageDriver) check(p.processedBy?.driver === profile.imageDriver, `processedBy.driver 应为 ${profile.imageDriver}：${p.processedBy?.driver}`);
    const thumb = await s.a.req('GET', p.urls.thumb, { raw: true, redirect: 'follow' });
    check(thumb.status === 200, `GET 缩略图 ${p.urls.thumb} → ${thumb.status}`);
    const meta = await sharp(thumb.body).metadata();
    check(meta.format === 'webp' && meta.width === 200, `缩略图应为 200 宽的 WebP：${meta.format} ${meta.width}x${meta.height}`);
    const display = await s.a.req('GET', p.urls.display, { raw: true, redirect: 'follow' });
    check(display.status === 200, `GET 展示图 → ${display.status}`);
    const dm = await sharp(display.body).metadata();
    check(dm.format === 'webp' && dm.width <= 1080, `展示图应为 ≤1080 宽的 WebP：${dm.format} ${dm.width}`);
    s.thumbUrl = p.urls.thumb;
    return `thumb ${meta.width}x${meta.height}（${thumb.body.length} B）· display ${dm.width}x${dm.height} · 主色 ${p.dominantColor ?? '?'} · takenAt ${p.takenAt ?? '-'}`;
  });
  await t.step('时间线（我的 / 公开）中出现该照片', async () => {
    const mine = expectStatus(await s.a.get('/api/feed?scope=mine'), 200);
    check(mine.body.items.some((x) => x.id === s.photoId), '我的时间线中没有该照片');
    const pub = expectStatus(await s.b.get('/api/feed?scope=public'), 200);
    check(pub.body.items.some((x) => x.id === s.photoId), '用户 B 的公开时间线中没有该照片');
    return `mine ${mine.body.items.length} 张 · public ${pub.body.items.length} 张`;
  });

  t.section(`${profile.name}：社交、通知、分享、日报`);
  await t.step('用户 B 点赞并评论', async () => {
    expectStatus(await s.b.post(`/social/photos/${s.photoId}/likes`, {}), 200, 201);
    const cm = expectStatus(await s.b.post(`/social/photos/${s.photoId}/comments`, { text: '好照片！smoke test' }), 200, 201);
    const counters = expectStatus(await s.a.get(`/social/photos/${s.photoId}`), 200);
    const likes = counters.body.counters?.likes ?? counters.body.likes;
    const comments = counters.body.counters?.comments ?? counters.body.comments;
    check(likes === 1 && comments === 1, `计数应为 1 赞 1 评：${JSON.stringify(counters.body)}`);
    const list = expectStatus(await s.a.get(`/social/photos/${s.photoId}/comments`), 200);
    check((list.body.items ?? []).length === 1, '评论列表应有 1 条');
    return `commentId=${cm.body.comment?.id ?? cm.body.id ?? '?'}`;
  });
  await t.step('用户 A 收到点赞与评论通知', async () => {
    let items = [];
    for (let i = 0; i < 40; i++) {
      items = expectStatus(await s.a.get('/api/notifications'), 200).body.items ?? [];
      if (items.some((n) => /like/i.test(n.type)) && items.some((n) => /comment/i.test(n.type))) break;
      await sleep(250);
    }
    check(items.some((n) => /like/i.test(n.type)), `没有点赞通知：${JSON.stringify(items.map((n) => n.type))}`);
    check(items.some((n) => /comment/i.test(n.type)), `没有评论通知：${JSON.stringify(items.map((n) => n.type))}`);
    const unread = expectStatus(await s.a.get('/api/notifications/unread-count'), 200);
    return `${items.length} 条：${[...new Set(items.map((n) => n.type))].join(', ')} · 未读 ${JSON.stringify(unread.body)}`;
  });
  await t.step('分享链接：创建 → 匿名打开 → 照片可见', async () => {
    const sh = expectStatus(await s.a.post('/api/shares', { photoId: s.photoId, ttlSec: 3600 }), 201);
    check(sh.body.token && sh.body.url, `分享响应不完整：${JSON.stringify(sh.body)}`);
    const anon = new Client(base);
    const open = expectStatus(await anon.get(`/api/shares/${encodeURIComponent(sh.body.token)}`), 200);
    check(open.body.photo?.id === s.photoId, '分享页应返回该照片');
    expectStatus(await anon.get('/api/shares/does-not-exist'), 410);
    return sh.body.url;
  });
  await t.step('日报：管理员立即生成当天日报（POST /api/reports/daily）', async () => {
    const tz = 'Asia/Tokyo';
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const r = expectStatus(await s.admin.post('/api/reports/daily', { day, notify: false }), 201);
    check(r.body.stats?.uploads >= 1 && r.body.stats?.likes >= 1 && r.body.stats?.comments >= 1, `日报统计不对：${JSON.stringify(r.body.stats)}`);
    const csv = await s.admin.req('GET', r.body.url, { redirect: 'follow' });
    check(csv.status === 200 && /uploads,/.test(String(csv.body)), `日报 CSV 不可读：${csv.status}`);
    return `${r.body.key} · uploads=${r.body.stats.uploads} likes=${r.body.stats.likes} comments=${r.body.stats.comments}`;
  });
  await t.step('日报：定时任务手动触发（POST /api/admin/jobs/report.daily/run）', async () => {
    const r = expectStatus(await s.admin.post('/api/admin/jobs/report.daily/run', {}), 200);
    check(r.body.status === 'ok', `report.daily 运行状态 ${r.body.status}：${JSON.stringify(r.body)}`);
    const list = expectStatus(await s.admin.get('/api/reports/daily'), 200);
    check(list.body.items.length >= 1, '日报列表为空');
    return `runId=${r.body.runId ?? r.body.id} · 列表 ${list.body.items.length} 份`;
  });

  t.section(`${profile.name}：capabilities、可观测性、旁路`);
  await t.step('GET /api/capabilities：驱动与状态符合档位', async () => {
    const pub = expectStatus(await new Client(base).get('/api/capabilities'), 200).body;
    const adm = expectStatus(await s.admin.get('/api/capabilities'), 200).body;
    check(adm.view === 'admin' && pub.view === 'public', `视图不对：${pub.view}/${adm.view}`);
    check(adm.validation.errors.length === 0, `validation.errors 不为空：${JSON.stringify(adm.validation.errors)}`);
    const problems = [];
    for (const [id, m] of Object.entries(adm.modules)) {
      const want = profile.expectModules?.[id];
      if (want?.driver && m.driver !== want.driver) problems.push(`${id}.driver=${m.driver}（期望 ${want.driver}）`);
      if (want?.status && m.status !== want.status) problems.push(`${id}.status=${m.status}（期望 ${want.status}）`);
      if (!want?.status) {
        const allowed = want?.allow ?? (m.status === 'off' ? ['ok'] : ['ok']);
        const health = m.status === 'off' ? m.localHealth : m.status;
        if (!allowed.includes(health)) problems.push(`${id}=${m.status}/${m.localHealth ?? '-'}：${m.detail}`);
      }
    }
    check(!problems.length, problems.join('\n'));
    const on = Object.entries(adm.modules).filter(([, m]) => m.status !== 'off').map(([id, m]) => `${id}:${m.driver}:${m.status}`);
    return `启用 ${on.join(', ')} · warnings ${adm.validation.warnings.length}`;
  });
  await t.step('响应头：X-CloudAlbum-Path 与 Server-Timing', async () => {
    const r = expectStatus(await s.a.get('/api/feed?scope=mine'), 200);
    const ph = pathHeader(r);
    const st = r.headers.get('server-timing') ?? '';
    const seg = segments(r);
    check(seg.entry === 'direct', `entry 应为 direct（开发机直连）：${ph}`);
    check(seg.database?.startsWith(profile.dbDriver), `路径头应有 database=${profile.dbDriver}…：${ph}`);
    check(/(^|,\s*)total;dur=/.test(st) && /database;dur=/.test(st), `Server-Timing 应含 total 与 database：${st}`);
    check(r.headers.get('x-cloudalbum-request-id'), '缺少 X-CloudAlbum-Request-Id');
    check(s.completePath.includes('image-processing='), `complete 的路径头应含 image-processing 段：${s.completePath}`);
    if (profile.storage) check(s.completePath.includes(`storage=${profile.storage}`), `complete 的路径头应含 storage=${profile.storage}：${s.completePath}`);
    return `${ph} | ${st}`;
  });
  if (profile.cacheDriver && profile.cacheDriver !== 'none') {
    await t.step(`缓存：第二次 GET /api/feed 命中（cache=${profile.cacheDriver}）`, async () => {
      await s.b.get('/api/feed?scope=public');
      const r = expectStatus(await s.b.get('/api/feed?scope=public'), 200);
      const c = segments(r).cache ?? '';
      check(/:hit$/.test(c), `第二次应命中：cache=${c}`);
      return `cache=${c}`;
    });
  }
  await t.step('X-Compare-Bypass: cache 只对管理员生效（普通用户 403，管理员 200 + bypass）', async () => {
    const denied = await s.a.get('/api/feed?scope=public', { headers: { 'X-Compare-Bypass': 'cache' } });
    check(denied.status === 403 && denied.body?.error === 'BYPASS_FORBIDDEN', `普通用户应为 403 BYPASS_FORBIDDEN：${denied.status} ${JSON.stringify(denied.body)}`);
    const anon = await new Client(base).get('/api/feed?scope=public', { headers: { 'X-Compare-Bypass': 'cache' } });
    check(anon.status === 403, `匿名用户应为 403：${anon.status}`);
    const ok = expectStatus(await s.admin.get('/api/feed?scope=public', { headers: { 'X-Compare-Bypass': 'cache' } }), 200);
    const seg = segments(ok);
    check(seg.bypass?.includes('cache'), `管理员旁路的路径头应有 bypass=cache：${pathHeader(ok)}`);
    check(ok.headers.get('x-cloudalbum-bypass') === 'cache', `应回显 X-CloudAlbum-Bypass: cache：${ok.headers.get('x-cloudalbum-bypass')}`);
    if (profile.cacheDriver && profile.cacheDriver !== 'none') check(/:bypass$/.test(seg.cache ?? ''), `cache 段应为 <驱动>:bypass：${seg.cache}`);
    return pathHeader(ok);
  });
  await t.step('审计：旁路请求写入 audit_log', async () => {
    const r = expectStatus(await s.admin.get('/api/admin/audit?action=lab.bypass'), 200);
    const items = r.body.items ?? [];
    check(items.some((x) => x.action === 'lab.bypass'), `audit_log 中没有 lab.bypass：${JSON.stringify(items).slice(0, 300)}`);
    const v = await s.admin.get('/api/admin/audit/verify');
    return `${items.length} 条 lab.bypass · 哈希链 ${v.status === 200 ? JSON.stringify(v.body).slice(0, 80) : v.status}`;
  });
  await t.step('/api/lab/self-check：AWS SDK 加载情况符合档位', async () => {
    const r = expectStatus(await s.admin.get('/api/lab/self-check'), 200);
    const loaded = r.body.awsSdk?.loaded ?? [];
    if (profile.expectNoAwsSdk) check(loaded.length === 0, `L0 不应加载任何 @aws-sdk：${loaded.join(', ')}`);
    check(r.body.ok === true, `self-check ok=false：${JSON.stringify(r.body).slice(0, 300)}`);
    return `awsSdk=${loaded.length ? loaded.join(',') : '无'} · ec2=${r.body.ec2?.status}`;
  });
  return s;
}
