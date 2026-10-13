// 浏览器内的模拟后端（开发用；后端路由还是 501 桩时让页面可以开发与演示）。
// 行为按 L0 本地实现模拟：auth=local（受限会话 + /me/outbox 验证）、storage=local（签名 PUT / 前缀令牌分片）、image-processing=inline、
// queue=sync、cache=none、database=sqlite、email=outbox。每个响应都带 L0 形状的 X-CloudAlbum-Path 与 Server-Timing。
// 数据只在内存中（刷新页面即重置，只保留“当前登录的是谁”）。
import {
  formatPathHeader, formatServerTiming, HEADERS, type ModuleId, type RegistryDocument, type ServerTimingMetric,
} from '@cloudalbum/contracts';
import type {
  AdminUser, Album, AuditEntry, Comment, JobRun, LabResultRow, Me, NotificationItem, OutboxEmailDetail, Photo,
} from '../api/types';
import { buildL0Capabilities, sampleImage } from './fixtures';

interface MockUser {
  id: string;
  email: string;
  displayName: string;
  password: string;
  role: 'admin' | 'member';
  emailVerified: boolean;
  disabled: boolean;
  createdAt: string;
  emailNotify: boolean;
}

interface Ctx {
  req: Request;
  url: URL;
  params: Record<string, string>;
  user: MockUser | null;
  json<T>(): Promise<T>;
  mark(module: ModuleId, value: string, ms?: number): void;
}

type Handler = (ctx: Ctx) => Promise<Response> | Response;

const SESSION_KEY = 'cloudalbum.mock.session';
const PAGE = 24;

let idSeq = 0;
function uid(prefix = ''): string {
  idSeq += 1;
  const rnd = Math.random().toString(16).slice(2, 10).padEnd(8, '0');
  const n = idSeq.toString(16).padStart(4, '0');
  return `${prefix}${rnd}-${n}-4000-8000-${Date.now().toString(16).slice(-12).padStart(12, '0')}`;
}

function iso(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function jitter(base: number, spread: number): number {
  return Math.round((base + Math.random() * spread) * 10) / 10;
}

export class HttpErr extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

export class MockBackend {
  users: MockUser[] = [];
  albums: Album[] = [];
  photos: Photo[] = [];
  blobs = new Map<string, Blob>();
  parts = new Map<string, Map<number, Blob>>();
  comments: Comment[] = [];
  likes = new Set<string>();
  shares = new Map<string, { photoId: string; expiresAt: string; by: string }>();
  notifications: Array<NotificationItem & { userId: string }> = [];
  outbox: Array<OutboxEmailDetail & { code?: string }> = [];
  runs: JobRun[] = [];
  audit: AuditEntry[] = [];
  results: LabResultRow[] = [];
  codes = new Map<string, { code: string; kind: 'verify' | 'reset' }>();
  sessionUserId: string | null = null;
  restricted = false;
  private routes: Array<{ method: string; re: RegExp; keys: string[]; handler: Handler }> = [];

  constructor(private readonly registry: RegistryDocument, opts: { seed?: boolean; persistSession?: boolean } = {}) {
    if (opts.seed !== false) this.seed();
    if (opts.persistSession) {
      try {
        const saved = globalThis.sessionStorage?.getItem(SESSION_KEY);
        if (saved && this.users.some((u) => u.id === saved)) this.sessionUserId = saved;
      } catch {
        /* 忽略 */
      }
    }
    this.persist = Boolean(opts.persistSession);
    this.registerRoutes();
  }

  private persist = false;

  // ------------------------------------------------------------------------------------------ 种子数据
  private seed(): void {
    // 种子数据用固定 ID：刷新页面后（模拟后端重建）登录状态与照片链接仍然有效
    const admin = this.addUser({ email: 'admin@example.com', displayName: '管理员', password: 'cloudalbum-dev-1', role: 'admin', emailVerified: true }, '00000000-0000-4000-8000-000000000001');
    const demo = this.addUser({ email: 'demo@example.com', displayName: '示例用户', password: 'cloudalbum-dev-1', role: 'member', emailVerified: true }, '00000000-0000-4000-8000-000000000002');
    const labels = ['东京塔', '海边', '雪山', '樱花', '夜景', '咖啡馆', '小猫', '晚霞', '山路', '湖面'];
    labels.forEach((label, i) => {
      const owner = i % 3 === 0 ? admin : demo;
      const img = sampleImage(i, label);
      const album = this.albums.find((a) => a.ownerId === owner.id)!;
      const p = this.newPhoto(owner, album.id, `${label}.jpg`, 'image/jpeg', 180_000 + i * 7000, `00000000-0000-4000-8000-1000000000${String(i).padStart(2, '0')}`);
      Object.assign(p, {
        status: 'READY', visibility: 'public', title: label, dominantColor: img.color, width: 1080, height: 810,
        createdAt: iso(-(i + 1) * 3_600_000), readyAt: iso(-(i + 1) * 3_600_000 + 900),
        urls: { thumb: img.url, display: img.url, original: img.url },
        processedBy: { driver: 'inline', durationMs: jitter(60, 80), host: 'i-0mock0000000000001' },
        labels: [{ name: 'orientation:landscape', confidence: 1, source: 'basic' }, { name: `color:${img.color}`, confidence: 0.9, source: 'basic' }],
      });
    });
    const first = this.photos[0]!;
    this.comments.push({ id: uid('c'), photoId: first.id, userId: demo.id, userName: demo.displayName, text: '好看！', createdAt: iso(-1_800_000) });
    this.likes.add(`${first.id}:${demo.id}`);
    this.notify(first.ownerId, 'comment.created', '新评论', `${demo.displayName} 评论了你的照片：好看！`, `/photos/${first.id}`);
    for (const name of ['report.daily', 'share.cleanup', 'image.reconcile', 'outbox.retention', 'lab.compact', 'lab.heartbeat', 'analytics.retention', 'audit.retention']) {
      this.runs.push({ runId: uid('r'), name, startedAt: iso(-600_000), finishedAt: iso(-599_800), status: 'ok', host: 'i-0mock0000000000001', trigger: 'cron', executor: 'worker', scheduledAt: iso(-600_000) });
    }
    this.runs.push({ runId: uid('r'), name: 'image.process', subjectId: first.id, startedAt: iso(-3_600_000), finishedAt: iso(-3_599_910), status: 'ok', host: 'i-0mock0000000000001', trigger: 'pipeline', executor: 'inline' });
    this.auditLog('system', null, 'module.status', 'module', 'ec2', 'success');
    this.seedResults();
  }

  private seedResults(): void {
    const mk = (module: string, experiment: string, label: string, p95: number, drivers: Record<string, string>, ago: number): LabResultRow => {
      const runId = `01MOCK${Math.random().toString(36).slice(2, 12).toUpperCase().padEnd(20, '0')}`;
      const startedAt = iso(-ago);
      const finishedAt = iso(-ago + 72_000);
      return {
        runId, module, experiment, label, startedAt, finishedAt, forced: false, uploadedAt: finishedAt,
        result: {
          schemaVersion: 1, runId, module, experiment, label, forced: false, startedAt, finishedAt,
          params: { vus: 10, duration: '60s', repeat: 1, ab: false },
          environment: { profile: label === 'after' ? `single/${module}` : 'l0-ec2', deployMode: 'single', instanceType: 't4g.small', drivers },
          client: { requests: 1840, errors: 0, latencyMs: { '/api/feed': { p50: p95 * 0.45, p95: p95 * 1.2, p99: p95 * 1.6 } } },
          server: {
            routes: { '/api/feed': { count: 1840, p50: p95 * 0.4, p95, errors: 0 } },
            ports: { database: { calls: label === 'after' ? 300 : 3680, p95: 2.1 } },
            host: { cpuP95: label === 'after' ? 18 : 41, eventLoopDelayP99: 12 },
            business: {},
          },
        },
      };
    };
    this.results.push(
      mk('cache', 'feed-read', 'before', 24.6, { cache: 'none', database: 'sqlite' }, 7_200_000),
      mk('cache', 'feed-read', 'after', 6.1, { cache: 'redis', database: 'sqlite' }, 3_600_000),
      mk('database', 'feed-read', 'before', 24.6, { database: 'sqlite' }, 9_000_000),
    );
  }

  addUser(u: Pick<MockUser, 'email' | 'displayName' | 'password' | 'role' | 'emailVerified'>, id = uid()): MockUser {
    const user: MockUser = { ...u, id, disabled: false, createdAt: iso(-86_400_000), emailNotify: true };
    this.users.push(user);
    const now = iso();
    this.albums.push({ id: `${id.slice(0, -4)}a${id.slice(-3)}`, ownerId: user.id, title: '默认相册', description: null, visibility: 'private', coverPhotoId: null, isDefault: true, createdAt: now, updatedAt: now });
    return user;
  }

  private newPhoto(owner: MockUser, albumId: string | null, filename: string, contentType: string, size: number, id = uid()): Photo {
    const now = iso();
    const p: Photo = {
      id, ownerId: owner.id, ownerName: owner.displayName, albumId, filename, contentType, sizeBytes: size,
      status: 'UPLOADING', visibility: 'private', title: null, caption: null, width: null, height: null, dominantColor: null,
      takenAt: null, createdAt: now, readyAt: null, labels: [], processedBy: null, urls: {},
    };
    this.photos.unshift(p);
    return p;
  }

  private notify(userId: string, type: string, title: string, body: string, link: string | null): void {
    this.notifications.unshift({ id: uid('n'), userId, type, title, body, link, readAt: null, createdAt: iso() });
  }

  private mail(to: MockUser | string, subject: string, category: string, text: string, code?: string): void {
    const addr = typeof to === 'string' ? to : to.email;
    const user = typeof to === 'string' ? this.users.find((u) => u.email === to) : to;
    const html = `<p>${text.replace(/\n/g, '<br>').replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>')}</p><p style="color:#888">— CloudAlbum（本地 outbox，未真正发出）</p>`;
    this.outbox.unshift({
      id: uid('m'), messageId: `<${uid()}@cloudalbum.local>`, to: [addr], subject, category, transport: 'outbox', status: 'sent',
      deliveryStatus: 'none', userId: user?.id ?? null, createdAt: iso(), sentAt: iso(), from: 'CloudAlbum <no-reply@cloudalbum.local>',
      html, text, hasBody: true, emlUrl: null, ...(code ? { code } : {}),
    });
  }

  private auditLog(actorType: string, actor: MockUser | null, action: string, targetType: string | null, targetId: string | null, result: string): void {
    this.audit.unshift({
      id: this.audit.length + 1, ts: iso(), actorType, actorId: actor?.id ?? null, actorEmail: actor?.email ?? null, action,
      targetType, targetId, result, sourceIp: '127.0.0.1', requestId: uid('q').slice(0, 26), awsPrincipal: null, details: null,
    });
  }

  private setSession(userId: string | null, restricted = false): void {
    this.sessionUserId = userId;
    this.restricted = restricted;
    if (!this.persist) return;
    try {
      if (userId && !restricted) globalThis.sessionStorage?.setItem(SESSION_KEY, userId);
      else globalThis.sessionStorage?.removeItem(SESSION_KEY);
    } catch {
      /* 忽略 */
    }
  }

  me(u: MockUser): Me {
    return {
      id: u.id, email: u.email, displayName: u.displayName, emailVerified: u.emailVerified, role: u.role,
      groups: [u.role], plan: 'free', provider: 'local', mfaEnabled: false, ...(this.restricted ? { restricted: true } : {}),
    };
  }

  /** 与后端 PhotoDto 同形：owner、counters、likedByMe、isOwner；不含 rawKey */
  publicPhoto(p: Photo, viewer: MockUser | null = null): Photo {
    const likes = [...this.likes].filter((k) => k.startsWith(`${p.id}:`)).length;
    const comments = this.comments.filter((c) => c.photoId === p.id).length;
    const { rawKey: _raw, ownerName: _name, ...rest } = p as Photo & { rawKey?: string };
    const owner = this.users.find((u) => u.id === p.ownerId);
    return {
      ...rest,
      owner: { id: p.ownerId, displayName: owner?.displayName ?? '' },
      counters: { likes, comments },
      likedByMe: Boolean(viewer && this.likes.has(`${p.id}:${viewer.id}`)),
      isOwner: viewer?.id === p.ownerId,
    };
  }

  private withCounters(p: Photo, viewer: MockUser | null): Photo {
    return this.publicPhoto(p, viewer);
  }

  private canSee(p: Photo, u: MockUser | null): boolean {
    return p.visibility === 'public' || (u !== null && (u.id === p.ownerId || u.role === 'admin'));
  }

  // ------------------------------------------------------------------------------------------ 路由
  private on(method: string, pattern: string, handler: Handler): void {
    const keys: string[] = [];
    const re = new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, (c) => (c === ':' ? c : `\\${c}`)).replace(/\\?:([a-zA-Z]+)/g, (_m, k: string) => { keys.push(k); return '([^/]+)'; })}$`);
    this.routes.push({ method, re, keys, handler });
  }

  private need(ctx: Ctx, opts: { allowRestricted?: boolean } = {}): MockUser {
    if (!ctx.user) throw new HttpErr(401, 'UNAUTHENTICATED', '需要登录');
    if (this.restricted && !opts.allowRestricted) throw new HttpErr(403, 'EMAIL_NOT_VERIFIED', '请先完成邮箱验证');
    return ctx.user;
  }

  private needAdmin(ctx: Ctx): MockUser {
    const u = this.need(ctx);
    if (u.role !== 'admin') throw new HttpErr(403, 'FORBIDDEN', '仅管理员可用');
    return u;
  }

  private registerRoutes(): void {
    // capabilities
    this.on('GET', '/api/capabilities', (ctx) => json(buildL0Capabilities(this.registry, ctx.user?.role === 'admin' && !this.restricted ? 'admin' : 'public')));
    this.on('GET', '/api/health/live', () => json({ status: 'live', role: 'api', mock: true }));
    this.on('GET', '/api/health/ready', () => json({ status: 'ready', scope: 'all', failing: [] }));

    // ---------------------------------------------------------------- auth
    this.on('POST', '/api/auth/register', async (ctx) => {
      const b = await ctx.json<{ email?: string; password?: string; displayName?: string }>();
      const email = (b.email ?? '').trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw new HttpErr(400, 'INVALID_EMAIL', '邮箱格式不正确');
      if ((b.password ?? '').length < 8 || !/\d/.test(b.password ?? '')) throw new HttpErr(400, 'WEAK_PASSWORD', '密码至少 8 位且包含数字');
      if (this.users.some((u) => u.email === email)) throw new HttpErr(409, 'EMAIL_TAKEN', '该邮箱已注册');
      ctx.mark('auth', 'local:register', jitter(40, 30));
      const user = this.addUser({ email, displayName: b.displayName?.trim() || email.split('@')[0]!, password: b.password ?? '', role: 'member', emailVerified: false });
      const code = String(Math.floor(100000 + Math.random() * 900000));
      this.codes.set(email, { code, kind: 'verify' });
      const origin = globalThis.location?.origin ?? 'http://localhost:5173';
      this.mail(user, '验证你的 CloudAlbum 邮箱', 'verification', `验证码：${code}\n或直接打开：${origin}/verify?email=${encodeURIComponent(email)}&code=${code}`, code);
      ctx.mark('email', 'outbox:stored', jitter(1, 2));
      this.setSession(user.id, true);
      this.auditLog('user', user, 'user.register', 'user', user.id, 'success');
      return json({ userId: user.id, needsConfirmation: true, restrictedSession: true }, 201);
    });
    this.on('POST', '/api/auth/confirm', async (ctx) => {
      const b = await ctx.json<{ email?: string; code?: string }>();
      const email = (b.email ?? ctx.user?.email ?? '').trim().toLowerCase();
      const rec = this.codes.get(email);
      const user = this.users.find((u) => u.email === email);
      if (!rec || rec.kind !== 'verify' || rec.code !== (b.code ?? '').trim() || !user) throw new HttpErr(400, 'INVALID_CODE', '验证码不正确或已过期');
      user.emailVerified = true;
      this.codes.delete(email);
      if (this.sessionUserId === user.id) this.setSession(null);
      return noContent();
    });
    this.on('POST', '/api/auth/resend', async (ctx) => {
      const b = await ctx.json<{ email?: string }>();
      const email = (b.email ?? '').trim().toLowerCase();
      const rec = this.codes.get(email);
      if (rec) this.mail(email, '验证你的 CloudAlbum 邮箱（重发）', 'verification', `验证码：${rec.code}`, rec.code);
      return noContent();
    });
    this.on('POST', '/api/auth/login', async (ctx) => {
      const b = await ctx.json<{ email?: string; password?: string }>();
      const user = this.users.find((u) => u.email === (b.email ?? '').trim().toLowerCase());
      ctx.mark('auth', 'local:login', jitter(45, 25));
      if (!user || user.password !== b.password || user.disabled) {
        this.auditLog('anonymous', null, 'user.login_failed', 'user', b.email ?? null, 'denied');
        throw new HttpErr(401, 'INVALID_CREDENTIALS', '邮箱或密码不正确');
      }
      if (!user.emailVerified) throw new HttpErr(403, 'EMAIL_NOT_VERIFIED', '邮箱尚未验证：请在“我的邮件”中查看验证邮件');
      this.setSession(user.id);
      this.auditLog('user', user, 'user.login', 'user', user.id, 'success');
      return json({ kind: 'tokens', user: this.me(user) });
    });
    this.on('POST', '/api/auth/refresh', (ctx) => (ctx.user ? noContent() : err(401, 'UNAUTHENTICATED', '会话已过期')));
    this.on('POST', '/api/auth/logout', () => { this.setSession(null); return noContent(); });
    this.on('POST', '/api/auth/forgot', async (ctx) => {
      const b = await ctx.json<{ email?: string }>();
      const email = (b.email ?? '').trim().toLowerCase();
      if (this.users.some((u) => u.email === email)) {
        const code = String(Math.floor(100000 + Math.random() * 900000));
        this.codes.set(email, { code, kind: 'reset' });
        this.mail(email, '重置 CloudAlbum 密码', 'password-reset', `验证码：${code}`, code);
      }
      return noContent(202);
    });
    this.on('POST', '/api/auth/reset', async (ctx) => {
      const b = await ctx.json<{ email?: string; code?: string; newPassword?: string }>();
      const email = (b.email ?? '').trim().toLowerCase();
      const rec = this.codes.get(email);
      const user = this.users.find((u) => u.email === email);
      if (!rec || rec.kind !== 'reset' || rec.code !== b.code || !user) throw new HttpErr(400, 'INVALID_CODE', '验证码不正确或已过期');
      user.password = b.newPassword ?? '';
      this.codes.delete(email);
      return noContent();
    });
    this.on('GET', '/api/auth/session', (ctx) => {
      const u = this.need(ctx);
      return json({ token: `mock-social.${u.id}`, expiresAt: iso(300_000) });
    });
    this.on('GET', '/api/me', (ctx) => {
      const u = this.need(ctx, { allowRestricted: true });
      ctx.mark('auth', 'local:verify', jitter(0.4, 0.4));
      return json(this.me(u));
    });
    this.on('GET', '/.well-known/jwks.json', () => json({ keys: [{ kty: 'EC', crv: 'P-256', kid: 'mock-1', use: 'sig', alg: 'ES256', x: 'mock', y: 'mock' }] }));

    // ---------------------------------------------------------------- 相册与照片
    this.on('GET', '/api/feed', (ctx) => {
      // 与后端一致：scope=mine（我的全部照片，含处理中）| public（所有人公开且 READY）；省略时按登录状态选择；游标字段为 next
      const viewer = ctx.user && !this.restricted ? ctx.user : null;
      const scope = ctx.url.searchParams.get('scope') ?? (viewer ? 'mine' : 'public');
      if (scope === 'mine' && !viewer) throw new HttpErr(401, 'UNAUTHENTICATED', '需要登录');
      const bypass = (ctx.req.headers.get(HEADERS.compareBypass) ?? '').includes('cache');
      ctx.mark('cache', bypass ? 'none:bypass' : 'none', 0.1);
      const all = scope === 'mine'
        ? this.photos.filter((p) => p.ownerId === viewer!.id)
        : this.photos.filter((p) => p.visibility === 'public' && p.status === 'READY');
      const start = Number(ctx.url.searchParams.get('cursor') ?? 0) || 0;
      const items = all.slice(start, start + PAGE).map((p) => this.withCounters(p, viewer));
      ctx.mark('database', 'sqlite', jitter(2.5, 3));
      ctx.mark('database', 'sqlite', jitter(1, 1.5));
      return json({ items, scope, ...(start + PAGE < all.length ? { next: String(start + PAGE) } : {}) });
    });
    this.on('GET', '/api/albums', (ctx) => {
      const u = this.need(ctx);
      ctx.mark('database', 'sqlite', jitter(1, 1));
      const items = this.albums.filter((a) => a.ownerId === u.id).map((a) => this.albumOut(a));
      return json({ items });
    });
    this.on('POST', '/api/albums', async (ctx) => {
      const u = this.need(ctx);
      const b = await ctx.json<{ title?: string; description?: string; visibility?: 'public' | 'private' }>();
      if (!b.title?.trim()) throw new HttpErr(400, 'TITLE_REQUIRED', '标题不能为空');
      const now = iso();
      const a: Album = { id: uid('a'), ownerId: u.id, title: b.title.trim(), description: b.description ?? null, visibility: b.visibility ?? 'private', coverPhotoId: null, isDefault: false, createdAt: now, updatedAt: now };
      this.albums.unshift(a);
      ctx.mark('database', 'sqlite', jitter(1, 1));
      return json(this.albumOut(a), 201);
    });
    this.on('GET', '/api/albums/:id', (ctx) => {
      const a = this.albums.find((x) => x.id === ctx.params.id);
      const viewer = ctx.user;
      if (!a || (a.visibility !== 'public' && a.ownerId !== viewer?.id)) throw new HttpErr(404, 'NOT_FOUND', '相册不存在');
      ctx.mark('cache', 'none', 0.1);
      ctx.mark('database', 'sqlite', jitter(2, 2));
      const photos = this.photos.filter((p) => p.albumId === a.id && this.canSee(p, viewer)).map((p) => this.withCounters(p, viewer));
      return json({ album: this.albumOut(a), photos, nextCursor: null });
    });
    this.on('PATCH', '/api/albums/:id', async (ctx) => {
      const u = this.need(ctx);
      const a = this.albums.find((x) => x.id === ctx.params.id && x.ownerId === u.id);
      if (!a) throw new HttpErr(404, 'NOT_FOUND', '相册不存在');
      Object.assign(a, await ctx.json<Partial<Album>>(), { updatedAt: iso() });
      return json(this.albumOut(a));
    });
    this.on('DELETE', '/api/albums/:id', (ctx) => {
      const u = this.need(ctx);
      const a = this.albums.find((x) => x.id === ctx.params.id && x.ownerId === u.id);
      if (!a) throw new HttpErr(404, 'NOT_FOUND', '相册不存在');
      if (a.isDefault) throw new HttpErr(409, 'DEFAULT_ALBUM', '默认相册不能删除');
      this.albums = this.albums.filter((x) => x !== a);
      for (const p of this.photos) if (p.albumId === a.id) p.albumId = null;
      return noContent();
    });

    this.on('POST', '/api/photos', async (ctx) => {
      const u = this.need(ctx);
      // 与后端 routes/photos.ts 一致：{photoId, photo, uploadTarget, upload, maxBytes}；F14 的 rawKey / uploadId 由前端按约定推出
      const b = await ctx.json<{ filename?: string; contentType?: string; size?: number; sizeBytes?: number; albumId?: string | null }>();
      const ct = (b.contentType ?? '').toLowerCase();
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(ct)) throw new HttpErr(415, 'UNSUPPORTED_TYPE', '只接受 JPEG / PNG / WebP');
      const size = b.size ?? b.sizeBytes ?? 0;
      if (size > 25 * 1024 * 1024) throw new HttpErr(413, 'TOO_LARGE', '超过 maxUploadMb=25');
      const albumId = b.albumId || this.albums.find((a) => a.ownerId === u.id && a.isDefault)?.id || null;
      const p = this.newPhoto(u, albumId, b.filename ?? 'photo', ct, size);
      const ext = ct === 'image/jpeg' ? 'jpg' : ct === 'image/png' ? 'png' : 'webp';
      const rawKey = `raw/${u.id}/${p.id}.${ext}`;
      (p as Photo & { rawKey?: string }).rawKey = rawKey;
      ctx.mark('database', 'sqlite', jitter(1, 1));
      ctx.mark('storage', 'local:sign', 0.2);
      const qs = new URLSearchParams({ key: rawKey, ct, max: String(25 * 1024 * 1024), exp: String(Math.floor(Date.now() / 1000) + 900), sig: 'mock' });
      const target = { method: 'PUT', url: `/api/storage/upload?${qs}`, headers: { 'Content-Type': ct }, expiresAt: iso(900_000) };
      return json({ photoId: p.id, photo: this.publicPhoto(p), uploadTarget: target, upload: target, maxBytes: 25 * 1024 * 1024 }, 201);
    });
    this.on('PUT', '/api/storage/upload', async (ctx) => {
      const key = ctx.url.searchParams.get('key') ?? '';
      const uploadId = ctx.url.searchParams.get('uploadId');
      const blob = await ctx.req.blob();
      if (uploadId) {
        const token = (ctx.req.headers.get('Authorization') ?? '').replace(/^CA-Upload\s+/i, '');
        const owner = token.startsWith('mock-upload.') ? token.slice('mock-upload.'.length) : null;
        if (!owner || !key.startsWith(`raw/${owner}/`)) throw new HttpErr(403, 'PREFIX_DENIED', '令牌不允许写这个前缀');
        const parts = this.parts.get(uploadId) ?? new Map<number, Blob>();
        this.parts.set(uploadId, parts);
        parts.set(Number(ctx.url.searchParams.get('part') ?? 1), blob);
        ctx.mark('storage', 'local:part', jitter(3, 4));
        return json({ ok: true }, 200, { ETag: `"mock-${parts.size}"` });
      }
      if (ctx.url.searchParams.get('sig') !== 'mock') throw new HttpErr(403, 'BAD_SIGNATURE', '签名无效');
      this.blobs.set(key, blob);
      ctx.mark('storage', 'local:write', jitter(4, 6));
      return noContent();
    });
    this.on('GET', '/api/storage/upload/parts', (ctx) => {
      const uploadId = ctx.url.searchParams.get('uploadId') ?? '';
      const parts = this.parts.get(uploadId);
      const list = parts ? [...parts.entries()].sort((a, b) => a[0] - b[0]).map(([part, b]) => ({ part, size: b.size })) : [];
      return json({ uploadId, key: ctx.url.searchParams.get('key'), parts: list, received: list.length });
    });
    this.on('POST', '/api/uploads/session', (ctx) => {
      const u = this.need(ctx);
      ctx.mark('identity-pool', 'none:token', 0.3);
      return json({ mode: 'token', token: `mock-upload.${u.id}`, expiresAt: iso(900_000), prefix: `raw/${u.id}/`, partSize: 1024 * 1024, partUrl: '/api/storage/upload' });
    });
    this.on('POST', '/api/photos/:id/complete', async (ctx) => {
      const u = this.need(ctx);
      const p = this.photos.find((x) => x.id === ctx.params.id && x.ownerId === u.id);
      if (!p) throw new HttpErr(404, 'NOT_FOUND', '照片不存在');
      if (p.status === 'READY') return json({ photo: this.withCounters(p, u) });
      const b = await ctx.json<{ uploadId?: string }>().catch(() => ({} as { uploadId?: string }));
      const rawKey = (p as Photo & { rawKey?: string }).rawKey ?? '';
      let blob = this.blobs.get(rawKey);
      const uploadId = b.uploadId ?? p.id;
      if (!blob && this.parts.has(uploadId)) {
        const parts = this.parts.get(uploadId);
        if (!parts?.size) throw new HttpErr(400, 'NO_PARTS', '没有收到任何分片');
        const ordered = [...parts.entries()].sort((x, y) => x[0] - y[0]).map(([, v]) => v);
        blob = new Blob(await Promise.all(ordered.map((b) => b.arrayBuffer())), { type: p.contentType });
        this.parts.delete(uploadId);
      }
      if (!blob) throw new HttpErr(400, 'NOT_UPLOADED', '原图还没有上传');
      const bypassQueue = (ctx.req.headers.get(HEADERS.compareBypass) ?? '').includes('queue');
      ctx.mark('database', 'sqlite', jitter(1, 1));
      ctx.mark('queue', bypassQueue ? 'sync:bypass-inline' : 'sync:inline', 0.2);
      const ms = jitter(50, 120);
      ctx.mark('image-processing', 'inline:sync', ms);
      ctx.mark('storage', 'local:write', jitter(3, 4));
      ctx.mark('tagging', 'none:basic', jitter(1, 2));
      ctx.mark('workflow', 'inline:sync', 0.1);
      const url = typeof URL.createObjectURL === 'function' ? URL.createObjectURL(blob) : '';
      Object.assign(p, {
        status: 'READY', sizeBytes: blob.size, readyAt: iso(), urls: { thumb: url, display: url, original: url },
        processedBy: { driver: 'inline', durationMs: ms, host: 'i-0mock0000000000001' }, width: 1080, height: 810,
        labels: [{ name: 'orientation:landscape', confidence: 1, source: 'basic' }],
      });
      this.runs.unshift({ runId: uid('r'), name: 'image.process', subjectId: p.id, startedAt: iso(-ms), finishedAt: iso(), status: 'ok', host: 'i-0mock0000000000001', trigger: 'pipeline', executor: 'inline' });
      return json({ photo: this.withCounters(p, u) });
    });
    this.on('GET', '/api/photos/:id', (ctx) => {
      const p = this.photos.find((x) => x.id === ctx.params.id);
      if (!p || !this.canSee(p, ctx.user)) throw new HttpErr(404, 'NOT_FOUND', '照片不存在');
      ctx.mark('database', 'sqlite', jitter(1, 1));
      ctx.mark('kms', 'local:encrypt', 0.1);
      return json(this.withCounters(p, ctx.user));
    });
    this.on('PATCH', '/api/photos/:id', async (ctx) => {
      const u = this.need(ctx);
      const p = this.photos.find((x) => x.id === ctx.params.id && x.ownerId === u.id);
      if (!p) throw new HttpErr(404, 'NOT_FOUND', '照片不存在');
      Object.assign(p, await ctx.json<Partial<Photo>>());
      return json(this.withCounters(p, u));
    });
    this.on('DELETE', '/api/photos/:id', (ctx) => {
      const u = this.need(ctx);
      const p = this.photos.find((x) => x.id === ctx.params.id && (x.ownerId === u.id || u.role === 'admin'));
      if (!p) throw new HttpErr(404, 'NOT_FOUND', '照片不存在');
      this.photos = this.photos.filter((x) => x !== p);
      ctx.mark('storage', 'local:delete', 1);
      this.auditLog('user', u, 'photo.delete', 'photo', p.id, 'success');
      return noContent();
    });
    this.on('GET', '/api/search', (ctx) => {
      const tag = ctx.url.searchParams.get('tag') ?? '';
      return json({ items: this.photos.filter((p) => this.canSee(p, ctx.user) && p.labels?.some((l) => l.name.includes(tag))) });
    });

    // ---------------------------------------------------------------- 社交（路径与后端 routes/social.ts 一致）
    const counters = (photoId: string, u: MockUser | null) => ({
      likes: [...this.likes].filter((k) => k.startsWith(`${photoId}:`)).length,
      comments: this.comments.filter((c) => c.photoId === photoId).length,
      likedByMe: Boolean(u && this.likes.has(`${photoId}:${u.id}`)),
    });
    const commentOut = (c: Comment, u: MockUser | null) => {
      const author = this.users.find((x) => x.id === c.userId);
      return { ...c, user: { id: c.userId, displayName: author?.displayName ?? '' }, mine: c.userId === u?.id };
    };
    this.on('GET', '/social/photos/:id', (ctx) => {
      ctx.mark('social-store', 'db', jitter(0.8, 1));
      const c = counters(ctx.params.id!, ctx.user);
      return json({ photoId: ctx.params.id, counters: { likes: c.likes, comments: c.comments }, likedByMe: c.likedByMe });
    });
    this.on('POST', '/social/photos/:id/likes', (ctx) => {
      const u = this.need(ctx);
      const p = this.photos.find((x) => x.id === ctx.params.id);
      if (!p) throw new HttpErr(404, 'NOT_FOUND', '照片不存在');
      const created = !this.likes.has(`${p.id}:${u.id}`);
      if (created && p.ownerId !== u.id) this.notify(p.ownerId, 'like.created', '有人赞了你的照片', `${u.displayName} 赞了你的照片`, `/photos/${p.id}`);
      this.likes.add(`${p.id}:${u.id}`);
      ctx.mark('social-store', 'db', jitter(1.5, 1));
      return json({ photoId: p.id, created, likes: counters(p.id, u).likes, likedByMe: true });
    });
    this.on('DELETE', '/social/photos/:id/likes', (ctx) => {
      const u = this.need(ctx);
      const removed = this.likes.delete(`${ctx.params.id}:${u.id}`);
      ctx.mark('social-store', 'db', jitter(1.5, 1));
      return json({ photoId: ctx.params.id, removed, likes: counters(ctx.params.id!, u).likes, likedByMe: false });
    });
    this.on('GET', '/social/photos/:id/comments', (ctx) => {
      ctx.mark('social-store', 'db', jitter(1, 1));
      return json({ items: this.comments.filter((c) => c.photoId === ctx.params.id).map((c) => commentOut(c, ctx.user)) });
    });
    this.on('POST', '/social/photos/:id/comments', async (ctx) => {
      const u = this.need(ctx);
      const p = this.photos.find((x) => x.id === ctx.params.id);
      if (!p) throw new HttpErr(404, 'NOT_FOUND', '照片不存在');
      const b = await ctx.json<{ text?: string }>();
      const text = (b.text ?? '').trim();
      if (!text) throw new HttpErr(400, 'EMPTY', '评论不能为空');
      const c: Comment = { id: uid('c'), photoId: p.id, userId: u.id, text, createdAt: iso() };
      this.comments.push(c);
      ctx.mark('social-store', 'db', jitter(2, 1));
      ctx.mark('queue', 'sync:inline', 0.2);
      if (p.ownerId !== u.id) {
        this.notify(p.ownerId, 'comment.created', '你的照片有新评论', `${u.displayName}：${text.slice(0, 140)}`, `/photos/${p.id}`);
        ctx.mark('notification', 'db:email', jitter(1, 1));
        const owner = this.users.find((x) => x.id === p.ownerId);
        if (owner?.emailNotify) {
          this.mail(owner, '你的照片有新评论', 'notification', `${u.displayName}：${text}\n${globalThis.location?.origin ?? ''}/photos/${p.id}`);
          ctx.mark('email', 'outbox:stored', jitter(1, 1));
        }
      }
      return json({ comment: commentOut(c, u) }, 201);
    });
    this.on('DELETE', '/social/photos/:id/comments/:commentId', (ctx) => {
      const u = this.need(ctx);
      const c = this.comments.find((x) => x.id === ctx.params.commentId && x.photoId === ctx.params.id);
      if (!c || (c.userId !== u.id && u.role !== 'admin')) throw new HttpErr(404, 'NOT_FOUND', '评论不存在');
      this.comments = this.comments.filter((x) => x !== c);
      return noContent();
    });
    this.on('POST', '/api/shares', async (ctx) => {
      const u = this.need(ctx);
      const b = await ctx.json<{ photoId?: string; ttlSec?: number }>();
      const p = this.photos.find((x) => x.id === b.photoId && (x.ownerId === u.id || u.role === 'admin'));
      if (!p) throw new HttpErr(404, 'PHOTO_NOT_FOUND', '照片不存在');
      if (p.status !== 'READY') throw new HttpErr(409, 'PHOTO_NOT_READY', '照片尚未就绪，不能分享');
      const token = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
      const createdAt = iso();
      const expiresAt = iso((b.ttlSec ?? 86400) * 1000);
      this.shares.set(token, { photoId: p.id, expiresAt, by: u.displayName });
      ctx.mark('social-store', 'db', jitter(1, 1));
      return json({ token, photoId: p.id, createdAt, expiresAt, url: `${globalThis.location?.origin ?? ''}/s/${token}`, apiUrl: `/api/shares/${token}` }, 201);
    });
    this.on('GET', '/api/shares/:token', (ctx) => {
      const s = this.shares.get(ctx.params.token!);
      ctx.mark('social-store', 'db', jitter(1, 1));
      if (!s) throw new HttpErr(404, 'SHARE_NOT_FOUND', '分享链接不存在');
      if (Date.parse(s.expiresAt) < Date.now()) throw new HttpErr(410, 'SHARE_EXPIRED', '分享链接已过期');
      const p = this.photos.find((x) => x.id === s.photoId);
      if (!p) throw new HttpErr(404, 'PHOTO_NOT_FOUND', '照片已删除');
      return json({ share: { token: ctx.params.token, expiresAt: s.expiresAt, createdAt: iso() }, photo: this.publicPhoto(p, null) });
    });

    // ---------------------------------------------------------------- 通知与本人 outbox
    this.on('GET', '/api/notifications', (ctx) => {
      const u = this.need(ctx);
      return json({ items: this.notifications.filter((n) => n.userId === u.id), nextCursor: null });
    });
    this.on('GET', '/api/notifications/unread-count', (ctx) => {
      const u = this.need(ctx);
      return json({ count: this.notifications.filter((n) => n.userId === u.id && !n.readAt).length });
    });
    this.on('POST', '/api/notifications/read-all', (ctx) => {
      const u = this.need(ctx);
      for (const n of this.notifications) if (n.userId === u.id) n.readAt ??= iso();
      return noContent();
    });
    this.on('POST', '/api/notifications/:id/read', (ctx) => {
      const u = this.need(ctx);
      const n = this.notifications.find((x) => x.id === ctx.params.id && x.userId === u.id);
      if (n) n.readAt ??= iso();
      return noContent();
    });
    this.on('GET', '/api/notifications/prefs', (ctx) => json({ emailEnabled: this.need(ctx).emailNotify, sns: null }));
    this.on('PUT', '/api/notifications/prefs', async (ctx) => {
      const u = this.need(ctx);
      u.emailNotify = Boolean((await ctx.json<{ emailEnabled?: boolean }>()).emailEnabled);
      return json({ emailEnabled: u.emailNotify, sns: null });
    });
    this.on('GET', '/api/me/outbox', (ctx) => {
      const u = this.need(ctx, { allowRestricted: true });
      ctx.mark('email', 'outbox:preview', 0.5);
      const items = this.outbox.filter((m) => m.category !== 'password-reset' && (m.userId === u.id || m.to.includes(u.email))).map(summary);
      return json({ items, selfPreview: true, transport: 'outbox' });
    });
    this.on('GET', '/api/me/outbox/:id', (ctx) => {
      const u = this.need(ctx, { allowRestricted: true });
      const m = this.outbox.find((x) => x.id === ctx.params.id && x.category !== 'password-reset' && (x.userId === u.id || x.to.includes(u.email)));
      if (!m) throw new HttpErr(404, 'NOT_FOUND', '邮件不存在');
      ctx.mark('email', 'outbox:preview', 0.5);
      return json(detail(m));
    });

    // ---------------------------------------------------------------- 管理后台
    this.on('GET', '/api/admin/users', (ctx) => {
      this.needAdmin(ctx);
      const q = (ctx.url.searchParams.get('q') ?? '').toLowerCase();
      const items: AdminUser[] = this.users
        .filter((u) => !q || u.email.includes(q) || u.displayName.toLowerCase().includes(q))
        .map((u) => this.adminUser(u));
      return json({ items, nextCursor: null });
    });
    this.on('PATCH', '/api/admin/users/:id', async (ctx) => {
      const admin = this.needAdmin(ctx);
      const u = this.users.find((x) => x.id === ctx.params.id);
      if (!u) throw new HttpErr(404, 'NOT_FOUND', '用户不存在');
      const b = await ctx.json<{ role?: 'admin' | 'member'; disabled?: boolean }>();
      if (b.role) u.role = b.role;
      if (b.disabled !== undefined) u.disabled = b.disabled;
      this.auditLog('admin', admin, 'user.update', 'user', u.id, 'success');
      return json(this.adminUser(u));
    });
    this.on('GET', '/api/admin/outbox', (ctx) => {
      this.needAdmin(ctx);
      const sp = ctx.url.searchParams;
      const items = this.outbox
        .filter((m) => (!sp.get('to') || m.to.some((t) => t.includes(sp.get('to')!))) && (!sp.get('category') || m.category === sp.get('category')) && (!sp.get('status') || m.status === sp.get('status')))
        .map(summary);
      return json({ items, nextCursor: null });
    });
    this.on('GET', '/api/admin/outbox/:id', (ctx) => {
      this.needAdmin(ctx);
      const m = this.outbox.find((x) => x.id === ctx.params.id);
      if (!m) throw new HttpErr(404, 'NOT_FOUND', '邮件不存在');
      return json(detail(m));
    });
    this.on('GET', '/api/admin/jobs', (ctx) => {
      this.needAdmin(ctx);
      const sched: Array<[string, string, string]> = [
        ['report.daily', '0 9 * * *', '每日统计日报（CSV → reports/daily/ → 邮件）'],
        ['share.cleanup', '*/15 * * * *', '清理过期分享链接'],
        ['image.reconcile', '* * * * *', '对账 PROCESSING 超时的照片'],
        ['outbox.retention', '30 3 * * *', '删除超过保留期的 outbox 邮件'],
        ['lab.compact', '0 4 * * *', 'LabMetricsStore 分钟级 → 小时级'],
        ['lab.heartbeat', '*/5 * * * *', '无副作用的对照任务'],
        ['analytics.retention', '0 5 * * *', '点击流保留期'],
        ['audit.retention', '0 6 * * *', '审计日志保留期'],
      ];
      return json({
        queue: { driver: 'sync', depth: 0, inFlight: 0, detail: '任务在请求内执行' },
        scheduler: { driver: 'cron', jobs: sched.map(([name, schedule, description]) => ({ name, schedule, description, lastRun: this.runs.find((r) => r.name === name) ?? null, nextRunAt: null })) },
        failed: [],
      });
    });
    this.on('GET', '/api/admin/jobs/runs', (ctx) => {
      this.needAdmin(ctx);
      const name = ctx.url.searchParams.get('name');
      return json({ items: this.runs.filter((r) => !name || r.name === name).slice(0, 100), nextCursor: null });
    });
    this.on('POST', '/api/admin/jobs/:name/run', (ctx) => {
      const admin = this.needAdmin(ctx);
      const run: JobRun = { runId: uid('r'), name: ctx.params.name!, startedAt: iso(), finishedAt: iso(30), status: 'ok', host: 'i-0mock0000000000001', trigger: 'manual', executor: 'worker', scheduledAt: iso() };
      this.runs.unshift(run);
      this.auditLog('admin', admin, 'job.trigger', 'job', run.name, 'success');
      return json(run);
    });
    this.on('POST', '/api/admin/jobs/failed/:id/replay', (ctx) => { this.needAdmin(ctx); return noContent(); });
    this.on('GET', '/api/admin/audit', (ctx) => {
      this.needAdmin(ctx);
      const sp = ctx.url.searchParams;
      const items = this.audit.filter((a) => (!sp.get('action') || a.action.includes(sp.get('action')!)) && (!sp.get('actor') || `${a.actorId} ${a.actorEmail}`.includes(sp.get('actor')!)));
      return json({ items, nextCursor: null });
    });
    this.on('GET', '/api/admin/audit/verify', (ctx) => { this.needAdmin(ctx); return json({ ok: true, checked: this.audit.length }); });

    // ---------------------------------------------------------------- /lab
    this.on('GET', '/api/lab/results', (ctx) => {
      this.needAdmin(ctx);
      const m = ctx.url.searchParams.get('module');
      return json({ items: this.results.filter((r) => !m || r.module === m), nextCursor: null });
    });
    this.on('GET', '/api/lab/results/:runId', (ctx) => {
      this.needAdmin(ctx);
      const r = this.results.find((x) => x.runId === ctx.params.runId);
      if (!r) throw new HttpErr(404, 'NOT_FOUND', '结果不存在');
      return json(r);
    });
    this.on('GET', '/api/lab/self-check', (ctx) => { this.needAdmin(ctx); return json({ awsSdkLoaded: [], mock: true }); });
  }

  private albumOut(a: Album): Album {
    const photos = this.photos.filter((p) => p.albumId === a.id);
    const cover = photos.find((p) => p.status === 'READY');
    return { ...a, photoCount: photos.length, coverUrl: cover?.urls.thumb ?? null };
  }

  private adminUser(u: MockUser): AdminUser {
    return {
      id: u.id, email: u.email, displayName: u.displayName, role: u.role, plan: 'free', provider: 'local', emailVerified: u.emailVerified,
      mfaEnabled: false, disabled: u.disabled, lockedUntil: null, createdAt: u.createdAt, photoCount: this.photos.filter((p) => p.ownerId === u.id).length,
    };
  }

  /** 处理一个请求；不是模拟范围内的路径返回 null */
  async handle(req: Request): Promise<Response | null> {
    const url = new URL(req.url, globalThis.location?.href ?? 'http://localhost/');
    if (!/^\/(api|social|media|\.well-known)(\/|$)/.test(url.pathname)) return null;
    const method = req.method.toUpperCase();
    const route = this.routes.find((r) => r.method === method && r.re.test(url.pathname));
    const t0 = globalThis.performance?.now?.() ?? Date.now();
    const segs = new Map<ModuleId, { value: string; dur: number; n: number }>();
    const user = this.sessionUserId ? this.users.find((u) => u.id === this.sessionUserId) ?? null : null;
    if (user && !url.pathname.startsWith('/api/capabilities')) segs.set('auth', { value: 'local:verify', dur: 0.3, n: 1 });
    let bodyCache: unknown;
    const ctx: Ctx = {
      req,
      url,
      params: {},
      user,
      json: async <T>() => {
        if (bodyCache === undefined) {
          const t = await req.text();
          bodyCache = t ? JSON.parse(t) : {};
        }
        return bodyCache as T;
      },
      mark: (module, value, ms = 0.5) => {
        const cur = segs.get(module);
        if (cur) {
          cur.value = value;
          cur.dur += ms;
          cur.n += 1;
        } else segs.set(module, { value, dur: ms, n: 1 });
      },
    };
    let res: Response;
    if (!route) {
      res = err(404, 'NOT_FOUND', `模拟后端没有 ${method} ${url.pathname}`);
    } else {
      const m = route.re.exec(url.pathname)!;
      route.keys.forEach((k, i) => { ctx.params[k] = decodeURIComponent(m[i + 1] ?? ''); });
      try {
        res = await route.handler(ctx);
      } catch (e) {
        res = e instanceof HttpErr ? err(e.status, e.code, e.message) : err(500, 'INTERNAL', (e as Error)?.message ?? String(e));
      }
    }
    const bypass = (req.headers.get(HEADERS.compareBypass) ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const elapsed = (globalThis.performance?.now?.() ?? Date.now()) - t0;
    const modTotal = [...segs.values()].reduce((s, v) => s + v.dur, 0);
    const metrics: ServerTimingMetric[] = [
      { name: 'total', dur: modTotal + elapsed + 0.8 },
      { name: 'app', dur: elapsed + 0.8 },
      ...[...segs.entries()].map(([name, v]) => ({ name, dur: v.dur, desc: v.n > 1 ? `${v.value} x${v.n}` : v.value })),
    ];
    const headers = new Headers(res.headers);
    headers.set(HEADERS.path, formatPathHeader({
      entry: 'direct', inst: 'i-0mock0000000000001', az: 'ap-northeast-1a',
      modules: [...segs.entries()].map(([k, v]) => [k, v.value] as const),
      bypass,
    }));
    headers.set(HEADERS.serverTiming, formatServerTiming(metrics));
    headers.set(HEADERS.requestId, `MOCK${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 8).toUpperCase()}`);
    if (bypass.length) {
      headers.set(HEADERS.bypass, bypass.join(','));
      headers.set('Cache-Control', 'private, no-store');
    }
    return new Response(res.status === 204 ? null : await res.text(), { status: res.status, headers });
  }
}

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...extra } });
}

function noContent(status = 204): Response {
  return new Response(null, { status });
}

function err(status: number, code: string, message: string): Response {
  return json({ error: code, message }, status);
}

function summary(m: OutboxEmailDetail): OutboxEmailDetail {
  const { html: _h, text: _t, ...rest } = m as OutboxEmailDetail & { code?: string };
  delete (rest as { code?: string }).code;
  return rest;
}

function detail(m: OutboxEmailDetail): OutboxEmailDetail {
  const { code: _c, ...rest } = m as OutboxEmailDetail & { code?: string };
  return rest;
}
