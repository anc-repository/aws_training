// backend/src/http/routes/uploads.ts —— F6 本地签名直传与 F14 本地前缀令牌（03#storage 第 1 节、02#identity-pool 第 1 节）
//
//   PUT  /api/storage/upload?key&ct&max&exp&sig          F6：HMAC 签名的上传目标（storage=local / efs）
//   PUT  /api/storage/upload?key&uploadId&part           F14：分片，令牌在请求头 Authorization: CA-Upload <令牌>（不进 URL、不进访问日志）
//   GET  /api/storage/upload/parts?uploadId&key          F14：已收到的分片（断点续传）
//   POST /api/uploads/session                            F14：开会话（X-Compare-Bypass: identity-pool 只在这里有效）
//   POST /api/uploads/parts:sign                         F14 + storage=s3：逐片换取预签名 UploadPart URL（同样带 CA-Upload 令牌）
//   GET  /api/uploads/credentials                        F14 + identity-pool=cognito：用 HttpOnly Cookie 中的 ID 令牌换取 STS 临时凭证
//
// F6 的检查顺序：① 签名与有效期（timingSafeEqual）② Content-Type 必须等于签名里的 ct ③ Content-Length 大于 max → 413，不读请求体
// ④ 剩余空间低于 STORAGE_LOCAL_MIN_FREE_PCT → 507 ⑤ 目标已存在：大小一致 200（幂等重试），否则 409
// ⑥ 流式写盘（.incoming → fsync → rename），超限 413；任何错误或客户端中断都删除临时文件。
// 不使用 multer 的内存存储：整个文件进 Node 堆会让“并发数 × 文件大小”的内存曲线失真（对比实验要避免）。
// 令牌的签发与校验在 DirectUploadPort（identity-pool 的 none 驱动）；本路由只负责字节落盘（LocalStorage 的分片辅助）。
import type { Express, Request, Response } from 'express';
import { z } from 'zod';
import type { Container } from '../../container.js';
import { asLocalMultipart, asLocalStorage } from '../../adapters/storage/local.js';
import { HttpError } from '../../errors.js';
import { isBypassed } from '../../observability/request-context.js';
import { ID_TOKEN_COOKIE, requireAuth } from '../middleware/auth.js';
import { noStore, parseOr400, viewerOf } from './social.js';

export const PATHS = [
  '/api/uploads/*rest',
  '/api/storage/upload',
  '/api/storage/upload/*rest',
] as const;

const MB = 1024 * 1024;

export function uploadToken(req: Request): string | null {
  const h = req.get('authorization');
  const m = h ? /^CA-Upload\s+(\S+)$/i.exec(h.trim()) : null;
  return m ? m[1]! : null;
}

function contentLengthOf(req: Request): number | undefined {
  const v = req.get('content-length');
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function mime(v: string | undefined): string {
  return (v ?? '').split(';')[0]!.trim().toLowerCase();
}

/** 客户端出错时也读完（丢弃）请求体，避免连接被重置导致浏览器看不到错误码 */
function reject(req: Request, res: Response, status: number, error: string, message: string): void {
  req.resume();
  noStore(res);
  res.status(status).json({ error, message });
}

const partQuery = z.object({
  key: z.string().min(1).max(512),
  uploadId: z.string().min(8).max(64),
  part: z.coerce.number().int().min(1).max(10_000),
});
const partsListQuery = z.object({ key: z.string().min(1).max(512), uploadId: z.string().min(8).max(64) });
const signBody = partQuery;

export function register(app: Express, c: Container): void {
  const maxUploadBytes = () => Math.floor(c.runtimeConfig().maxUploadMb * MB);

  app.put('/api/storage/upload', async (req, res) => {
    // ---- F14：分片 ----
    if (req.query.uploadId !== undefined || req.query.part !== undefined) {
      const token = uploadToken(req);
      if (!token) return reject(req, res, 401, 'UPLOAD_TOKEN_REQUIRED', '分片上传需要请求头 Authorization: CA-Upload <令牌>');
      const q = partQuery.safeParse(req.query);
      if (!q.success) return reject(req, res, 400, 'BAD_REQUEST', 'key、uploadId、part 参数不完整或非法');
      const local = asLocalMultipart(c.storage);
      if (!local) return reject(req, res, 400, 'USE_PARTS_SIGN', 'storage=s3：请改用 POST /api/uploads/parts:sign 换取预签名 UploadPart URL');
      if (typeof c.directUpload.authorizePart !== 'function') return reject(req, res, 404, 'NOT_AVAILABLE', '当前 identity-pool 驱动不签发前缀令牌');
      try {
        await c.directUpload.authorizePart(token, q.data.key, q.data.uploadId, q.data.part);
      } catch (e) {
        req.resume();
        throw e;
      }
      const cl = contentLengthOf(req);
      const r = await local.writePart(q.data.uploadId, q.data.part, req, { maxBytes: maxUploadBytes(), ...(cl !== undefined ? { contentLength: cl } : {}) });
      if (!r.ok) return reject(req, res, r.status, r.code, r.message);
      noStore(res);
      res.set('ETag', r.etag).json({ uploadId: q.data.uploadId, part: r.part, size: r.size, etag: r.etag });
      return;
    }

    // ---- F6：签名上传目标 ----
    const local = asLocalStorage(c.storage);
    if (!local) return reject(req, res, 404, 'NOT_AVAILABLE', 'storage=s3：上传直接发往 S3 预签名 URL');
    const check = await local.verifyUploadSignature(req.query as Record<string, unknown>);
    if (!check.ok) return reject(req, res, 403, check.code, check.message);
    if (mime(req.get('content-type')) !== mime(check.contentType)) {
      return reject(req, res, 415, 'CONTENT_TYPE_MISMATCH', `请求头 Content-Type 必须是 ${check.contentType}`);
    }
    const cl = contentLengthOf(req);
    const r = await local.writeUpload(check.key, req, { maxBytes: check.maxBytes, contentType: check.contentType, ...(cl !== undefined ? { contentLength: cl } : {}) });
    if (!r.ok) return reject(req, res, r.status, r.code, r.message);
    noStore(res);
    if (r.info.etag) res.set('ETag', r.info.etag);
    res.json({ key: r.info.key, size: r.info.size, ...(r.sha256 ? { sha256: r.sha256 } : {}), ...(r.idempotent ? { idempotent: true } : {}) });
  });

  app.get('/api/storage/upload/parts', async (req, res) => {
    const token = uploadToken(req);
    if (!token) throw new HttpError(401, 'UPLOAD_TOKEN_REQUIRED', '需要请求头 Authorization: CA-Upload <令牌>');
    const q = parseOr400(partsListQuery, req.query);
    const local = asLocalMultipart(c.storage);
    if (!local) throw new HttpError(400, 'USE_PARTS_SIGN', 'storage=s3：分片状态由 S3 维护');
    if (typeof c.directUpload.authorizePart !== 'function') throw new HttpError(404, 'NOT_AVAILABLE', '当前 identity-pool 驱动不签发前缀令牌');
    // 列出分片只需要证明令牌对这个键有效：按第 1 片做一次授权检查
    await c.directUpload.authorizePart(token, q.key, q.uploadId, 1);
    const parts = await local.listParts(q.uploadId);
    noStore(res);
    res.json({ uploadId: q.uploadId, key: q.key, parts, received: parts.length, bytes: parts.reduce((s, p) => s + p.size, 0) });
  });

  app.post('/api/uploads/session', requireAuth, async (req, res) => {
    const v = viewerOf();
    const session = await c.directUpload.openSession(v.principal!, { bypass: isBypassed('identity-pool') });
    noStore(res);
    res.status(201).json(session);
  });

  // 路径中带冒号（parts:sign）：用正则注册，避免被当成路由参数
  app.post(/^\/api\/uploads\/parts:sign$/, async (req, res) => {
    const token = uploadToken(req);
    if (!token) throw new HttpError(401, 'UPLOAD_TOKEN_REQUIRED', '需要请求头 Authorization: CA-Upload <令牌>');
    const body = parseOr400(signBody, req.body);
    if (typeof c.directUpload.authorizePart !== 'function') throw new HttpError(404, 'NOT_AVAILABLE', '当前 identity-pool 驱动不签发前缀令牌');
    const r = await c.directUpload.authorizePart(token, body.key, body.uploadId, body.part);
    noStore(res);
    const url = r.url ?? `/api/storage/upload?${new URLSearchParams({ key: body.key, uploadId: body.uploadId, part: String(body.part) }).toString()}`;
    res.json({ url, method: 'PUT', part: body.part });
  });

  app.get('/api/uploads/credentials', requireAuth, async (req, res) => {
    const v = viewerOf();
    if (typeof c.directUpload.credentials !== 'function') throw new HttpError(404, 'NOT_AVAILABLE', 'identity-pool 未启用（当前为应用自签的前缀令牌）');
    const idToken = (req.cookies as Record<string, string> | undefined)?.[ID_TOKEN_COOKIE];
    if (!idToken) throw new HttpError(401, 'ID_TOKEN_REQUIRED', '缺少 ID 令牌 Cookie');
    const creds = await c.directUpload.credentials(v.principal!, idToken);
    noStore(res);
    res.json(creds);
  });
}
