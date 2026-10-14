// backend/src/adapters/identity-pool/lab-routes.ts —— identity-pool 的 /lab 侧路端点（02#identity-pool 第 5、11、12 节；仅管理员）
//
//   GET /api/lab/identity-pool/whoami            当前登录者的 F14 授权：none → 令牌前缀 raw/<userId>/ 与有效期；
//                                                cognito → identityId、暂存前缀、最近一次签发的 ASIA 凭证剩余时间（不含密钥）、
//                                                Uploader 角色的资源模板（策略变量）与是否正在退回前缀令牌
//   GET /api/lab/identity-pool/staging-object?key=private/<identityId>/<file>
//                                                服务端证据：暂存桶中这个键是否存在（cross-prefix 实验确认“写别人的前缀没有写进去”、
//                                                “写自己的前缀确实写进去了”；只能查询暂存前缀之内的键）
// 另外导出：
//   - identityPoolLabProbe(c)：/api/lab/probe/identity-pool 的处理函数（06 PM-11）。none：为 _probe/ 签发并丢弃一个前缀令牌
//     （identity-pool=none:token）；cognito：DescribeIdentityPool + HeadBucket（identity-pool=cognito:probe）。
//   - idTokenOf(req)：/api/uploads/credentials 取 ID 令牌——HttpOnly Cookie ca_it（BFF 子模式），没有时取请求头
//     X-CloudAlbum-Id-Token（auth=cognito 的 Amplify 子模式：令牌在浏览器内存中，不在 Cookie 里）。
// 注册：与 http/routes/*.ts 相同的 register(app, c) 形状；由集成阶段加入 http/app.ts 的 ROUTE_MODULES（先于 routes/lab.ts）。
import type { Express, Request } from 'express';
import type { Container } from '../../container.js';
import { HttpError } from '../../errors.js';
import { requireAdmin } from '../../http/middleware/admin.js';
import { ID_TOKEN_COOKIE, requireAuth } from '../../http/middleware/auth.js';
import { currentContext } from '../../observability/request-context.js';
import { findUserById } from '../../repositories/users.js';
import type { IssuedCredentialsInfo } from './cognito.js';

export const PATHS = ['/api/lab/identity-pool/whoami', '/api/lab/identity-pool/staging-object'] as const;

/** Amplify 子模式下前端把 ID 令牌放在这个请求头里（只发给同源的 /api/uploads/credentials） */
export const ID_TOKEN_HEADER = 'X-CloudAlbum-Id-Token';

interface CognitoLabSide {
  labProbe(): Promise<Record<string, unknown>>;
  stagingObject(key: string): Promise<{ key: string; exists: boolean; size?: number; contentType?: string }>;
  lastIssued(userId: string): IssuedCredentialsInfo | null;
  fallbackReason(): string | null;
  readonly poolId: string;
  readonly bucket: string;
  readonly uploadPrefix: string;
  readonly region: string;
}

interface LabProbeSide { labProbe(): Promise<Record<string, unknown>> }

function cognitoSide(c: Pick<Container, 'directUpload'>): CognitoLabSide | null {
  const d = c.directUpload as unknown as Partial<CognitoLabSide>;
  return c.directUpload.meta.driver === 'cognito' && typeof d.stagingObject === 'function' ? (d as CognitoLabSide) : null;
}

/** ID 令牌：Cookie ca_it 优先，其次请求头 X-CloudAlbum-Id-Token；都没有返回 '' */
export function idTokenOf(req: Request): string {
  const cookie = (req.cookies as Record<string, string> | undefined)?.[ID_TOKEN_COOKIE];
  if (cookie) return cookie;
  const h = req.get(ID_TOKEN_HEADER)?.trim() ?? '';
  return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(h) && h.length <= 8192 ? h : '';
}

/** /api/lab/probe/identity-pool 的响应体（由 http/routes/lab-probe.ts 的 guarded() 包装） */
export async function identityPoolLabProbe(c: Pick<Container, 'directUpload'>): Promise<Record<string, unknown>> {
  const d = c.directUpload as unknown as Partial<LabProbeSide>;
  if (typeof d.labProbe !== 'function') throw Object.assign(new Error('当前 identity-pool 驱动没有探测实现'), { code: 'PROBE_UNAVAILABLE' });
  return d.labProbe();
}

export function register(app: Express, c: Container): void {
  const admin = [requireAuth, requireAdmin];

  app.get('/api/lab/identity-pool/whoami', ...admin, async (_req, res) => {
    res.set('Cache-Control', 'no-store');
    const ctx = currentContext();
    const uid = ctx?.userId ?? ctx?.principal?.subject ?? '';
    const cfg = c.config.identity;
    const side = cognitoSide(c);
    if (!side) {
      res.json({
        driver: c.directUpload.meta.driver, mode: 'token', prefix: `raw/${uid}/`, tokenTtlSec: cfg.IDENTITY_TOKEN_TTL_SEC,
        partSizeMb: cfg.IDENTITY_PART_SIZE_MB, authorizedBy: 'application',
        partUrl: c.config.storage.STORAGE_DRIVER === 's3' ? '/api/uploads/parts:sign' : '/api/storage/upload',
      });
      return;
    }
    const row = uid ? await findUserById(c.db, uid) : undefined;
    const identityId = row?.identity_id ?? null;
    const issued = uid ? side.lastIssued(uid) : null;
    const remainingSec = issued ? Math.max(0, Math.round((Date.parse(issued.expiration) - Date.now()) / 1000)) : null;
    res.json({
      driver: 'cognito', mode: 'sts', authorizedBy: 'iam-policy-variable', identityPoolId: side.poolId, region: side.region,
      stagingBucket: side.bucket, uploadPrefix: side.uploadPrefix, identityId,
      prefix: identityId ? `${side.uploadPrefix}${identityId}/` : null,
      policyResource: `arn:aws:s3:::${side.bucket}/${side.uploadPrefix}\${cognito-identity.amazonaws.com:sub}/*`,
      credentials: issued ? { ...issued, remainingSec } : null,
      fallback: side.fallbackReason(),
    });
  });

  app.get('/api/lab/identity-pool/staging-object', ...admin, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const side = cognitoSide(c);
    if (!side) throw new HttpError(404, 'NOT_AVAILABLE', 'identity-pool 未启用（none 驱动没有暂存桶）');
    const key = typeof req.query.key === 'string' ? req.query.key : '';
    if (!key || key.length > 512) throw new HttpError(400, 'VALIDATION_FAILED', '需要查询参数 key（暂存前缀之内的键）');
    res.json(await side.stagingObject(key));
  });
}
