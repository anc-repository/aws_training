/**
 * experiments/_lib/app.ts —— 对 CloudAlbum API 的业务级封装（场景共用）。
 *
 *   上传：POST /api/photos → PUT uploadTarget（local：/api/storage/upload?…；s3：预签名 URL）→ POST /api/photos/:id/complete
 *   就绪：GET /api/photos/:id 直到 READY / FAILED（readyAt − createdAt = 缩略图就绪时间）
 *   登录：POST /api/auth/login → Set-Cookie ca_at（access token，作为 Bearer 复用）
 */
import { cookieValue, type ExpClient, type ExpResponse } from './http.js';
import type { ScenarioContext } from './scenario.js';
import type { TestImage } from './images.js';
import { mapLimit, percentile, round1, sleep } from './util.js';

export const ROUTES = {
  createPhoto: '/api/photos',
  upload: '/api/storage/upload',
  complete: '/api/photos/:id/complete',
  photo: '/api/photos/:id',
  feed: '/api/feed',
  albums: '/api/albums',
  album: '/api/albums/:id',
  comments: '/social/photos/:id/comments',
  me: '/api/me',
  login: '/api/auth/login',
  logout: '/api/auth/logout',
} as const;

export interface UploadTarget {
  method: 'PUT';
  url: string;
  headers: Record<string, string>;
  expiresAt?: string;
}

export interface PhotoDto {
  id: string;
  status: string;
  createdAt?: string;
  readyAt?: string | null;
  updatedAt?: string;
  failureReason?: string | null;
  processedBy?: { driver?: string; durationMs?: number; coldStart?: boolean } | null;
  urls?: { thumb?: string | null; display?: string | null; original?: string | null };
}

export interface UploadedPhoto {
  id: string;
  /** complete 的 HTTP 状态（200 = inline 当场 READY，202 = 异步） */
  completeStatus: number;
  completeMs: number;
  status: string;
  mode?: string;
  variant?: 'A' | 'B';
  /** 客户端时间：开始建档、complete 返回 */
  startedAt: number;
  completedAt: number;
  error?: string;
}

export interface UploadOptions {
  image: TestImage;
  /** complete 参与 A/B */
  abComplete?: boolean;
  title?: string;
  visibility?: 'public' | 'private';
  albumId?: string;
}

/** 走完一次“建档 → PUT → complete”。任何一步失败都返回带 error 的结果（不抛出），由调用方计数。 */
export async function uploadPhoto(ctx: ScenarioContext, opts: UploadOptions): Promise<UploadedPhoto> {
  const startedAt = Date.now();
  const create = await ctx.client.post(ROUTES.createPhoto, {
    route: ROUTES.createPhoto,
    json: {
      contentType: opts.image.contentType,
      size: opts.image.buffer.length,
      filename: `exp-${ctx.runId.slice(-8).toLowerCase()}.jpg`,
      visibility: opts.visibility ?? 'private',
      title: opts.title ?? `experiment ${ctx.module}/${ctx.experiment.id} ${ctx.label}`,
      ...(opts.albumId ? { albumId: opts.albumId } : {}),
    },
  });
  if (!create.ok) return failed(startedAt, `create ${create.status} ${create.error ?? create.text().slice(0, 200)}`);
  const body = create.json<{ photoId?: string; uploadTarget?: UploadTarget; upload?: UploadTarget; photo?: PhotoDto }>();
  const id = body.photoId ?? body.photo?.id;
  const target = body.uploadTarget ?? body.upload;
  if (!id || !target) return failed(startedAt, 'create: 响应缺少 photoId / uploadTarget');
  ctx.cleanupLater('DELETE', `/api/photos/${id}`);

  const put = await putUpload(ctx, target, opts.image.buffer);
  if (!put.ok) return { ...failed(startedAt, `upload ${put.status} ${put.error ?? put.text().slice(0, 200)}`), id };

  const done = await ctx.client.post(`/api/photos/${id}/complete`, { route: ROUTES.complete, ab: opts.abComplete === true, json: {} });
  const completedAt = Date.now();
  if (!done.ok) {
    return { id, completeStatus: done.status, completeMs: done.totalMs, status: 'ERROR', startedAt, completedAt,
      ...(done.variant ? { variant: done.variant } : {}), error: `complete ${done.status} ${done.error ?? done.text().slice(0, 200)}` };
  }
  const r = done.json<{ status?: string; mode?: string; photo?: PhotoDto }>();
  return {
    id, completeStatus: done.status, completeMs: done.totalMs, status: r.status ?? r.photo?.status ?? 'UNKNOWN',
    ...(r.mode ? { mode: r.mode } : {}), ...(done.variant ? { variant: done.variant } : {}), startedAt, completedAt,
  };
}

function failed(startedAt: number, error: string): UploadedPhoto {
  return { id: '', completeStatus: 0, completeMs: 0, status: 'ERROR', startedAt, completedAt: Date.now(), error };
}

/** PUT 到上传目标：相对 URL 走目标客户端（local 档，经 EC2）；绝对 URL 且跨源（S3 预签名）不带令牌与实验头。 */
export async function putUpload(ctx: ScenarioContext, target: UploadTarget, body: Buffer): Promise<ExpResponse> {
  const headers = { ...target.headers };
  const absolute = /^https?:\/\//i.test(target.url);
  const sameOrigin = absolute && new URL(target.url).origin === new URL(ctx.client.base).origin;
  if (!absolute || sameOrigin) {
    return ctx.client.request(target.method ?? 'PUT', target.url, { headers, body, route: ROUTES.upload, timeoutMs: 300_000 });
  }
  const host = new URL(target.url).hostname;
  const tag = /\.s3[.-]/.test(host) || host.startsWith('s3.') ? 's3' : 'external';
  const external = ctx.http(new URL(target.url).origin, { target: tag, auth: false, experiment: false });
  return external.request(target.method ?? 'PUT', target.url, { headers, body, route: `${tag}:upload`, timeoutMs: 300_000 });
}

export interface ReadyResult {
  id: string;
  status: string;
  /** 服务端 readyAt − createdAt（毫秒） */
  timeToReadyMs?: number;
  /** 客户端观测：complete 返回到看见 READY */
  observedMs?: number;
  processedBy?: PhotoDto['processedBy'];
  failureReason?: string | null;
}

/** 轮询照片直到 READY / FAILED / BLOCKED 或超时（轮询请求记在 `GET /api/photos/:id` 下，不参与 A/B）。 */
export async function waitReady(
  ctx: ScenarioContext,
  photos: readonly UploadedPhoto[],
  opts: { timeoutMs: number; intervalMs?: number; concurrency?: number },
): Promise<ReadyResult[]> {
  const deadline = Date.now() + opts.timeoutMs;
  const interval = opts.intervalMs ?? 1000;
  const pending = new Map<string, UploadedPhoto>();
  const results = new Map<string, ReadyResult>();
  for (const p of photos) if (p.id && !p.error) pending.set(p.id, p);
  while (pending.size && Date.now() < deadline && !ctx.signal.aborted) {
    const ids = [...pending.keys()];
    await mapLimit(ids, opts.concurrency ?? 8, async (id) => {
      const res = await ctx.client.get(`/api/photos/${id}`, { route: ROUTES.photo });
      if (!res.ok) return;
      const dto = res.json<PhotoDto>();
      if (['READY', 'FAILED', 'BLOCKED'].includes(dto.status)) {
        const up = pending.get(id)!;
        const created = dto.createdAt ? Date.parse(dto.createdAt) : NaN;
        const ready = dto.readyAt ? Date.parse(dto.readyAt) : NaN;
        results.set(id, {
          id, status: dto.status,
          ...(Number.isFinite(created) && Number.isFinite(ready) ? { timeToReadyMs: Math.max(0, ready - created) } : {}),
          observedMs: Date.now() - up.startedAt,
          ...(dto.processedBy !== undefined ? { processedBy: dto.processedBy } : {}),
          ...(dto.failureReason !== undefined ? { failureReason: dto.failureReason } : {}),
        });
        pending.delete(id);
      }
    });
    if (pending.size) await sleep(interval, ctx.signal);
  }
  for (const id of pending.keys()) results.set(id, { id, status: 'TIMEOUT' });
  return photos.filter((p) => p.id && !p.error).map((p) => results.get(p.id)!);
}

/** 上传类实验共用的业务指标（总纲 §8.2 的 biz.*）。 */
export function uploadBusiness(ctx: ScenarioContext, uploads: readonly UploadedPhoto[], ready: readonly ReadyResult[]): void {
  const ttr = ready.map((r) => r.timeToReadyMs).filter((v): v is number => v !== undefined);
  const observed = ready.filter((r) => r.status === 'READY').map((r) => r.observedMs).filter((v): v is number => v !== undefined);
  const lost = ready.filter((r) => r.status === 'TIMEOUT').length;
  const failed = ready.filter((r) => r.status === 'FAILED').length;
  ctx.business('photosUploaded', uploads.filter((u) => !u.error).length);
  ctx.business('uploadErrors', uploads.filter((u) => u.error).length);
  ctx.business('photoTimeToReadyP50', round1(percentile(ttr, 50)));
  ctx.business('photoTimeToReadyP95', round1(percentile(ttr, 95)));
  ctx.business('photoTimeToReadyMax', ttr.length ? Math.max(...ttr) : undefined);
  ctx.business('photoObservedReadyP95', round1(percentile(observed, 95)));
  ctx.business('jobsLost', lost);
  ctx.business('photosFailed', failed);
  const firstComplete = Math.min(...uploads.filter((u) => !u.error).map((u) => u.completedAt));
  const lastReady = Math.max(...ready.filter((r) => r.status === 'READY' && r.observedMs !== undefined)
    .map((r) => (uploads.find((u) => u.id === r.id)?.startedAt ?? 0) + (r.observedMs ?? 0)));
  if (Number.isFinite(firstComplete) && Number.isFinite(lastReady) && lastReady >= firstComplete) {
    ctx.business('drainTimeMs', lastReady - firstComplete);
  }
  const procDurations = ready.map((r) => r.processedBy?.durationMs).filter((v): v is number => typeof v === 'number');
  ctx.business('processingDurationP95', round1(percentile(procDurations, 95)));
  ctx.business('coldStarts', ready.filter((r) => r.processedBy?.coldStart === true).length);
  const byDriver: Record<string, number> = {};
  for (const r of ready) {
    const d = r.processedBy?.driver;
    if (d) byDriver[d] = (byDriver[d] ?? 0) + 1;
  }
  if (Object.keys(byDriver).length) ctx.finding('processedBy', byDriver);
  const modes: Record<string, number> = {};
  for (const u of uploads) if (u.mode) modes[u.mode] = (modes[u.mode] ?? 0) + 1;
  if (Object.keys(modes).length) ctx.finding('completeModes', modes);
}

/** 登录（local 驱动）：返回 access token（来自 Set-Cookie `ca_at`，也接受响应体中的 accessToken）。 */
export async function loginLocal(
  client: ExpClient, email: string, password: string, opts: { route?: string; expect?: number[] } = {},
): Promise<{ res: ExpResponse; token?: string; mfa?: boolean }> {
  const res = await client.post(ROUTES.login, { route: opts.route ?? ROUTES.login, auth: false, json: { email, password }, expect: opts.expect ?? [200] });
  if (!res.ok) return { res };
  let body: { kind?: string; accessToken?: string; tokens?: { accessToken?: string } } = {};
  try {
    body = res.json();
  } catch {
    /* 非 JSON */
  }
  if (body.kind === 'mfa_required') return { res, mfa: true };
  const token = cookieValue(res.setCookie, 'ca_at') ?? body.accessToken ?? body.tokens?.accessToken;
  return token ? { res, token } : { res };
}

/** 不校验签名地解码 JWT（仅用于展示声明）。 */
export function decodeJwt(token: string): { header: Record<string, unknown>; payload: Record<string, unknown> } | undefined {
  const parts = token.split('.');
  if (parts.length < 2) return undefined;
  try {
    const dec = (s: string) => JSON.parse(Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')) as Record<string, unknown>;
    return { header: dec(parts[0]!), payload: dec(parts[1]!) };
  } catch {
    return undefined;
  }
}

/** 读取 `--param users=<csv>` / `EXP_USERS_FILE` 中的测试账号（每行 `email,password`，# 开头为注释）。 */
export function parseUsersCsv(text: string): Array<{ email: string; password: string }> {
  return text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
    .map((l) => {
      const [email, ...rest] = l.split(',');
      return { email: (email ?? '').trim(), password: rest.join(',').trim() };
    })
    .filter((u) => u.email.includes('@') && u.password && u.email.toLowerCase() !== 'email');
}

/** 取一张可以评论的照片：时间线的第一张；没有时上传一张小图。 */
export async function ensureTargetPhoto(ctx: ScenarioContext, image: TestImage): Promise<string | undefined> {
  const feed = await ctx.client.get(`${ROUTES.feed}?scope=mine&limit=5`, { route: ROUTES.feed, record: false });
  if (feed.ok) {
    const items = feed.json<{ items?: PhotoDto[] }>().items ?? [];
    const ready = items.find((p) => p.status === 'READY');
    if (ready) return ready.id;
  }
  const up = await uploadPhoto(ctx, { image });
  if (up.error) return undefined;
  const [r] = await waitReady(ctx, [up], { timeoutMs: 60_000, intervalMs: 500 });
  return r?.status === 'READY' ? up.id : undefined;
}
