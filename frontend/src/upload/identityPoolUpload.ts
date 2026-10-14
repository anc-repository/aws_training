// F14（identity-pool=cognito）：STS 临时凭证 + IAM 策略变量，分片直传模块自带的暂存桶 private/<identityId>/<photoId>.<ext>，
// complete 时服务端校验后 CopyObject 导入原图键（02 组 identity-pool 第 2 节）。
//
//   1. GET /api/uploads/credentials → {accessKeyId: ASIA…, secretAccessKey, sessionToken, expiration, identityId, bucket, prefix}
//      （ID 令牌：BFF 子模式在 HttpOnly Cookie ca_it 里；Amplify 子模式由 setIdTokenProvider 提供，放在请求头 X-CloudAlbum-Id-Token）；
//   2. POST /api/photos 建档（与其他上传方式相同），暂存键 = 凭证前缀 + photoId + 原图键的扩展名；
//   3. 浏览器自己用 SigV4 签名，直接调用 S3：CreateMultipartUpload → UploadPart × N → CompleteMultipartUpload（中间没有发往 EC2 的请求）；
//      凭证快过期（< 5 分钟）时重新请求 /api/uploads/credentials，大文件上传途中也能续上；分片遇到 ExpiredToken 时刷新后重试一次；
//   4. 续传：同一个文件再次上传时沿用 photoId 与 S3 UploadId，先 ListParts，只补传缺失的分片；
//   5. POST /api/photos/:id/complete —— 服务端校验大小、类型、文件头后 CopyObject 到 raw/<userId>/<photoId>.<ext>。
// 越权（写别人的前缀、列整个桶、删别人的对象）由 S3 按 IAM 策略返回 403 AccessDenied，应用代码不参与。
import { api, ApiError } from '../api/client';
import { photosApi } from '../api/endpoints';
import type { CreatePhotoResponse, DirectUploadSession, Photo, TempAwsCredentials } from '../api/types';
import { recordTrace } from '../trace/TraceStore';
import { UploadHttpError, xhrPut, type PutImpl } from './http';
import { DEFAULT_PART_SIZE, deriveRawKey, partCount } from './prefixTokenUpload';
import { s3KeyPath, signRequest } from './sigv4';
import type { MultipartContext, ResumeState } from './types';

export type StsSession = Extract<DirectUploadSession, { mode: 'sts' }>;

/** Amplify 子模式：后端没有 ca_it Cookie，前端把 ID 令牌放在这个请求头里（只发给同源的 /api/uploads/credentials） */
export const ID_TOKEN_HEADER = 'X-CloudAlbum-Id-Token';
/** 凭证剩余有效期低于这个值就刷新 */
export const REFRESH_BEFORE_MS = 5 * 60_000;

type IdTokenProvider = () => Promise<string | null>;
let idTokenProvider: IdTokenProvider | null = null;

/** auth=cognito 的 Amplify 子模式由 CognitoAuthProvider 设置；BFF 子模式不需要（令牌在 HttpOnly Cookie 里） */
export function setIdTokenProvider(p: IdTokenProvider | null): void {
  idTokenProvider = p;
}

/** GET /api/uploads/credentials（Amplify 子模式附带 ID 令牌请求头） */
export async function fetchUploadCredentials(): Promise<TempAwsCredentials> {
  let token: string | null = null;
  try {
    token = idTokenProvider ? await idTokenProvider() : null;
  } catch {
    token = null;
  }
  return api<TempAwsCredentials>('/api/uploads/credentials', token ? { headers: { [ID_TOKEN_HEADER]: token } } : {});
}

/** 非 PUT 的 S3 请求（创建 / 列出 / 完成 / 中止分片上传）；测试可注入 */
export type S3Fetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) =>
  Promise<{ status: number; text: string }>;

export interface IdentityPoolUploadContext extends Omit<MultipartContext, 'session' | 'openSession'> {
  session: StsSession;
  /** GET /api/uploads/credentials（默认 fetchUploadCredentials） */
  credentials?: () => Promise<TempAwsCredentials>;
  /** 测试注入 */
  s3fetch?: S3Fetch;
  createPhoto?: typeof photosApi.create;
  completePhoto?: (id: string) => Promise<Photo>;
  now?: () => number;
}

/** 暂存键：<凭证前缀 private/<identityId>/><photoId>.<原图键的扩展名>（后端 complete 按同一规则找对象） */
export function stagingKey(prefix: string, photoId: string, rawKey: string): string {
  const ext = (/\.([A-Za-z0-9]{1,8})$/.exec(rawKey)?.[1] ?? 'bin').toLowerCase();
  return `${prefix.replace(/\/?$/, '/')}${photoId}.${ext}`;
}

export function s3Host(bucket: string, region: string): string {
  return `${bucket}.s3.${region}.amazonaws.com`;
}

function xmlTag(xml: string, tag: string): string | undefined {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml);
  return m ? m[1]!.replace(/&quot;/g, '"').replace(/&amp;/g, '&') : undefined;
}

/** ListParts 的 XML → part → ETag */
export function parseListParts(xml: string): { parts: Array<{ part: number; etag: string; size: number }>; truncated: boolean; next?: string } {
  const parts: Array<{ part: number; etag: string; size: number }> = [];
  for (const m of xml.matchAll(/<Part>([\s\S]*?)<\/Part>/g)) {
    const body = m[1]!;
    const part = Number(xmlTag(body, 'PartNumber'));
    const etag = xmlTag(body, 'ETag') ?? '';
    if (part > 0) parts.push({ part, etag, size: Number(xmlTag(body, 'Size') ?? 0) });
  }
  const next = xmlTag(xml, 'NextPartNumberMarker');
  return { parts, truncated: xmlTag(xml, 'IsTruncated') === 'true', ...(next ? { next } : {}) };
}

export function completeXml(parts: ReadonlyArray<{ part: number; etag: string }>): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  return `<CompleteMultipartUpload>${[...parts].sort((a, b) => a.part - b.part)
    .map((p) => `<Part><PartNumber>${p.part}</PartNumber><ETag>${esc(p.etag)}</ETag></Part>`).join('')}</CompleteMultipartUpload>`;
}

function s3Error(status: number, text: string, what: string): UploadHttpError {
  const code = xmlTag(text, 'Code');
  const msg = xmlTag(text, 'Message');
  return new UploadHttpError(status, `${what}失败（HTTP ${status}${code ? ` ${code}` : ''}）${msg ? `：${msg}` : ''}`);
}

const defaultS3Fetch: S3Fetch = async (url, init) => {
  const start = globalThis.performance?.now?.() ?? Date.now();
  const res = await globalThis.fetch(url, { method: init.method, headers: init.headers, ...(init.body !== undefined ? { body: init.body } : {}), ...(init.signal ? { signal: init.signal } : {}) });
  recordTrace({ startTime: start, method: init.method, url, status: res.status, durationMs: (globalThis.performance?.now?.() ?? Date.now()) - start, serverTiming: [], pathRaw: '' });
  return { status: res.status, text: await res.text() };
};

/** 凭证缓存：快过期时刷新（REFRESH_BEFORE_MS） */
export class CredentialCache {
  private cur: TempAwsCredentials | null = null;
  private inflight: Promise<TempAwsCredentials> | null = null;
  constructor(private readonly load: () => Promise<TempAwsCredentials>, private readonly now: () => number = Date.now) {}

  async get(force = false): Promise<TempAwsCredentials> {
    const exp = this.cur ? Date.parse(this.cur.expiration) : 0;
    if (!force && this.cur && Number.isFinite(exp) && exp - this.now() > REFRESH_BEFORE_MS) return this.cur;
    this.inflight ??= this.load().then((c) => {
      this.cur = c;
      return c;
    }).finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }
}

/** 一个会话（多文件）共用的凭证缓存：同一批上传只换一次凭证 */
const sharedCaches = new WeakMap<StsSession, CredentialCache>();

export async function identityPoolUpload(file: File, ctx: IdentityPoolUploadContext): Promise<Photo> {
  const put: PutImpl = ctx.put ?? xhrPut;
  const s3fetch = ctx.s3fetch ?? defaultS3Fetch;
  let cache = sharedCaches.get(ctx.session);
  if (!cache) {
    cache = new CredentialCache(ctx.credentials ?? fetchUploadCredentials, ctx.now ?? Date.now);
    sharedCaches.set(ctx.session, cache);
  }
  // 先换凭证再建档：凭证不可用（503）时还没有留下 UPLOADING 的照片，调用方可以直接退回前缀令牌
  let creds = await cache.get();
  const region = creds.region || ctx.session.region;
  const bucket = creds.bucket || ctx.session.bucket;
  const host = s3Host(bucket, region);
  const partSize = Math.max(5 * 1024 * 1024, ctx.session.partSize > 0 ? ctx.session.partSize : DEFAULT_PART_SIZE);

  const signed = async (method: string, key: string, query: Record<string, string>, headers: Record<string, string> = {}, c = creds) =>
    signRequest({ method, host, path: s3KeyPath(key), query, headers, region, credentials: c });

  let state: ResumeState & { stagingKey?: string };
  const resume = ctx.resume?.stagingKey ? ctx.resume : undefined;
  if (resume) {
    state = { ...resume, done: { ...resume.done } };
  } else {
    ctx.onStage?.('create');
    const created: CreatePhotoResponse = await (ctx.createPhoto ?? photosApi.create)({
      filename: file.name,
      contentType: file.type || 'application/octet-stream',
      sizeBytes: file.size,
      albumId: ctx.albumId ?? null,
      transfer: 'multipart',
    });
    ctx.onCreated?.(created.photo);
    const photoId = created.photo.id;
    const rawKey = created.rawKey ?? deriveRawKey('raw/', photoId, created.photo.contentType || file.type);
    const key = stagingKey(creds.prefix, photoId, rawKey);
    const req = await signed('POST', key, { uploads: '' }, { 'content-type': file.type || 'application/octet-stream' });
    const r = await s3fetch(req.url, { method: 'POST', headers: req.headers, ...(ctx.signal ? { signal: ctx.signal } : {}) });
    if (r.status !== 200) throw s3Error(r.status, r.text, 'CreateMultipartUpload ');
    const uploadId = xmlTag(r.text, 'UploadId');
    if (!uploadId) throw new UploadHttpError(r.status, 'CreateMultipartUpload 没有返回 UploadId');
    state = { photoId, rawKey, uploadId, done: {}, stagingKey: key };
  }
  ctx.onResumeState?.(state);
  const key = state.stagingKey!;

  // 续传：问 S3 已经收到了哪些分片（ETag 用于合并）
  if (resume) {
    let marker: string | undefined;
    for (let i = 0; i < 100; i += 1) {
      const req = await signed('GET', key, { uploadId: state.uploadId, ...(marker ? { 'part-number-marker': marker } : {}) });
      const r = await s3fetch(req.url, { method: 'GET', headers: req.headers });
      if (r.status !== 200) break;   // 查询失败：已记录的分片照常跳过，其余重传
      const page = parseListParts(r.text);
      for (const p of page.parts) state.done[p.part] = p.etag;
      if (!page.truncated || !page.next) break;
      marker = page.next;
    }
    ctx.onResumeState?.(state);
  }

  ctx.onStage?.('upload');
  const total = partCount(file.size, partSize);
  const partBytes = (part: number) => Math.max(0, Math.min(partSize, file.size - (part - 1) * partSize));
  const doneBytes = () => Object.keys(state.done).reduce((s, p) => s + partBytes(Number(p)), 0);
  ctx.onProgress?.(doneBytes(), file.size);

  for (let part = 1; part <= total; part += 1) {
    if (state.done[part]) continue;
    if (ctx.signal?.aborted) throw new DOMException('上传已取消', 'AbortError');
    const blob = file.slice((part - 1) * partSize, Math.min(file.size, part * partSize));
    const base = doneBytes();
    let attempt = 0;
    for (;;) {
      creds = await cache.get(attempt > 0);
      const req = await signed('PUT', key, { partNumber: String(part), uploadId: state.uploadId }, {}, creds);
      const r = await put(req.url, blob, {
        headers: req.headers, onProgress: (loaded) => ctx.onProgress?.(base + loaded, file.size), ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
      if (r.status >= 200 && r.status < 300) {
        if (!r.etag) throw new UploadHttpError(r.status, `分片 ${part} 的响应里读不到 ETag（暂存桶的 CORS 必须暴露 ETag）`);
        state.done[part] = r.etag;
        break;
      }
      // 凭证在上传途中过期：刷新一次再试；其他错误（AccessDenied 等）原样抛出
      if (attempt === 0 && r.status === 400 && /ExpiredToken/.test(r.responseText)) {
        attempt += 1;
        continue;
      }
      if (attempt === 0 && r.status === 403 && /ExpiredToken|InvalidToken/.test(r.responseText)) {
        attempt += 1;
        continue;
      }
      throw s3Error(r.status, r.responseText, `分片 ${part} `);
    }
    ctx.onResumeState?.(state);
    ctx.onProgress?.(doneBytes(), file.size);
  }

  ctx.onStage?.('complete');
  creds = await cache.get();
  const body = completeXml(Object.entries(state.done).map(([p, etag]) => ({ part: Number(p), etag })));
  const req = await signed('POST', key, { uploadId: state.uploadId }, { 'content-type': 'application/xml' }, creds);
  const r = await s3fetch(req.url, { method: 'POST', headers: req.headers, body, ...(ctx.signal ? { signal: ctx.signal } : {}) });
  // CompleteMultipartUpload 可能以 200 返回 <Error>（S3 的已知行为）
  if (r.status !== 200 || /<Error>/.test(r.text)) throw s3Error(r.status === 200 ? 500 : r.status, r.text, 'CompleteMultipartUpload ');
  return (ctx.completePhoto ?? ((id: string) => photosApi.complete(id)))(state.photoId);
}

/** 用户取消上传：中止 S3 分片上传（释放已上传的分片；生命周期规则 1 天后也会清理） */
export async function abortIdentityPoolUpload(state: ResumeState, ctx: Pick<IdentityPoolUploadContext, 'session' | 'credentials' | 's3fetch'>): Promise<void> {
  if (!state.stagingKey) return;
  const creds = await (ctx.credentials ?? fetchUploadCredentials)();
  const region = creds.region || ctx.session.region;
  const req = await signRequest({
    method: 'DELETE', host: s3Host(creds.bucket || ctx.session.bucket, region), path: s3KeyPath(state.stagingKey), query: { uploadId: state.uploadId },
    region, credentials: creds,
  });
  await (ctx.s3fetch ?? defaultS3Fetch)(req.url, { method: 'DELETE', headers: req.headers });
}

/** 凭证接口返回 503（Identity Pool 不可用）：后端此时会为新会话发放前缀令牌 */
export function isCredentialsUnavailable(e: unknown): boolean {
  return e instanceof ApiError && e.status === 503;
}
