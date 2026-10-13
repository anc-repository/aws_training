// backend/src/http/routes/lab-modules.ts —— 模块自己的 /lab 侧路端点（experiments/ 的场景脚本调用；先于 routes/lab.ts 注册）
//
//   GET  /api/public/now                     { now }，Cache-Control: public, s-maxage=10, max-age=0（cdn 微缓存对照，匿名）
//   GET  /api/lab/now                        { now }，private, no-store（cdn：经 CDN 的 API 不缓存）
//   GET  /api/lab/iam/whoami                 { arn, accessKeyPrefix, expiration, source, kind }（iam：凭证来源）
//   POST /api/lab/iam/refresh                AwsCredentialsPort.forceRefresh()（撤销会话实验）
//   GET  /api/lab/aws-ping                   { sts: { ok, error? }, iam: { ok, error? } }（认证 vs 授权两列）
//   POST /api/lab/db/read-after-write        { visible, lagMs? }：主库写一行后立即从读库读（database：只读副本滞后）
//   POST /api/lab/storage/upload-target      ?driver=local|s3，body {contentType,size} → { uploadTarget }（lab/ 命名空间；只支持当前驱动）
// 除 /api/public/now 外都只对管理员开放（与 routes/lab.ts 相同的守卫）。响应形状是 experiments 小节约定的格式。
import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import { z } from 'zod';
import type { Container } from '../../container.js';
import { HttpError } from '../../errors.js';
import { checkCallerAndAuthorization } from '../../modules/detectors/iam.js';
import { requireAdmin } from '../middleware/admin.js';
import { requireAuth } from '../middleware/auth.js';
import { parseBody } from './auth.js';

export const PATHS = [
  '/api/public/now',
  '/api/lab/now',
  '/api/lab/iam/whoami',
  '/api/lab/iam/refresh',
  '/api/lab/aws-ping',
  '/api/lab/db/read-after-write',
  '/api/lab/storage/upload-target',
] as const;

const UploadTargetBody = z.object({ contentType: z.string().min(1).max(64), size: z.coerce.number().int().positive().optional() });

export function register(app: Express, c: Container): void {
  const admin = [requireAuth, requireAdmin];

  app.get('/api/public/now', (_req, res) => {
    res.set('Cache-Control', 'public, s-maxage=10, max-age=0').json({ now: new Date().toISOString() });
  });

  app.get('/api/lab/now', ...admin, (_req, res) => {
    res.set('Cache-Control', 'private, no-store').json({ now: new Date().toISOString() });
  });

  app.get('/api/lab/iam/whoami', ...admin, async (_req, res) => {
    res.set('Cache-Control', 'no-store');
    if (c.awsCreds.mode === 'none') {
      res.json({ kind: 'none', source: 'none', arn: null, accessKeyPrefix: null, expiration: null });
      return;
    }
    try {
      const d = await c.awsCreds.describe();
      res.json({
        kind: d.kind, arn: d.arn ?? null, accessKeyPrefix: d.keyPrefix ?? null, expiration: d.expiresAt ?? null,
        source: c.awsCreds.mode === 'role' ? 'imds' : 'static',
      });
    } catch (e) {
      throw new HttpError(503, 'AWS_IDENTITY_UNAVAILABLE', (e as Error).message);
    }
  });

  app.post('/api/lab/iam/refresh', ...admin, async (_req, res) => {
    await c.awsCreds.forceRefresh();
    res.set('Cache-Control', 'no-store').json({ ok: true, mode: c.awsCreds.mode, at: new Date().toISOString() });
  });

  app.get('/api/lab/aws-ping', ...admin, async (_req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!c.aws.enabled) {
      res.json({ sts: { ok: false, error: 'IAM_CREDENTIALS=none' }, iam: { ok: false, error: 'IAM_CREDENTIALS=none' } });
      return;
    }
    const r = await checkCallerAndAuthorization(c.aws);
    res.json({
      sts: r.authenticated ? { ok: true, arn: r.arn } : { ok: false, error: r.authError },
      iam: r.authorized === true ? { ok: true } : { ok: false, error: r.authzError ?? (r.authenticated ? '未检查（调用者不是角色或用户）' : '认证失败') },
    });
  });

  app.post('/api/lab/db/read-after-write', ...admin, async (_req, res) => {
    const key = `lab.raw.${randomUUID()}`;
    const t0 = Date.now();
    await c.db('system_meta').insert({ key, value: String(t0), updated_at: new Date(t0).toISOString() });
    try {
      const first = await c.dbRead('system_meta').where({ key }).first('value');
      if (first) {
        res.set('Cache-Control', 'no-store').json({ visible: true, lagMs: 0, replica: c.dbRead !== c.db });
        return;
      }
      // 读不到：轮询读库直到可见（最多 2 秒），给出滞后
      for (;;) {
        await new Promise((r) => setTimeout(r, 20));
        const row = await c.dbRead('system_meta').where({ key }).first('value');
        if (row || Date.now() - t0 > 2000) {
          res.set('Cache-Control', 'no-store').json({ visible: false, ...(row ? { lagMs: Date.now() - t0 } : {}), replica: c.dbRead !== c.db });
          return;
        }
      }
    } finally {
      await c.db('system_meta').where({ key }).del().catch(() => undefined);
    }
  });

  app.post('/api/lab/storage/upload-target', ...admin, async (req, res) => {
    const driver = String(req.query.driver ?? c.storage.meta.driver);
    if (driver !== c.storage.meta.driver) {
      throw new HttpError(409, 'DRIVER_NOT_ACTIVE', `当前存储驱动是 ${c.storage.meta.driver}，不能签发 ${driver} 的上传目标（并排对比需要两套部署）`);
    }
    const body = parseBody(UploadTargetBody, req.body);
    const maxBytes = Math.floor(c.runtimeConfig().maxUploadMb * 1024 * 1024);
    if (body.size && body.size > maxBytes) throw new HttpError(413, 'UPLOAD_TOO_LARGE', `超过上限 ${maxBytes} 字节`);
    const key = `lab/upload-sidebyside/${randomUUID()}.bin`;
    const s = c.config.storage;
    const ttl = s.STORAGE_DRIVER === 's3' ? s.STORAGE_S3_PRESIGN_TTL_SEC : 900;
    const uploadTarget = await c.storage.createUploadTarget({ key, contentType: body.contentType, maxBytes, expiresInSec: ttl });
    res.set('Cache-Control', 'no-store').json({ key, uploadTarget });
  });
}
