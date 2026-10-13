// backend/src/http/routes/lab-probe.ts —— /api/lab/probe/*（06 PM-11）：只读、可经任意入口到达、只给探测主体 atl-probe
//
//   GET /api/lab/probe/now        ConfigPort（config=…）、主库 select now()（database 段总是出现）、CachePort cache-aside（键 probe:now:<inst>，30 秒）
//   GET /api/lab/probe/echo       回显入口信息（从不回显 Cookie、Authorization 与任何令牌的值）
//   GET /api/lab/probe/media-url  MediaUrlBuilder 为保留键 _probe/<inst>/probe.jpg（及 variants/ 键）生成 URL（StoragePort 签名、CdnPort 改写）
//   GET /api/lab/probe/kms        CryptoPort 对 32 个随机字节加密再解密（P1）
//   GET /api/lab/probe/auth       AuthPort 的公开配置与签名公钥（P1）
// 通用：只在平台模式下注册（关闭时 404，不暴露端点存在）；只接受 GET（其他方法 405）；必须是 atl-probe（否则 401，错误码见 PM-09）；
// Cache-Control: private, no-store；总是带 X-CloudAlbum-Path 与 Server-Timing；端口运行时故障 → 503 {ok:false,error}；
// 未知端点 → 404 PROBE_UNKNOWN。错误体 {"error":{"code","message"}}（06 §1.5 第 4 条）。
import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import type { Express, Request, RequestHandler, Response } from 'express';
import { PLATFORM_HEADERS } from '@cloudalbum/contracts';
import type { Container } from '../../container.js';
import { isLoopback } from '../../config/net.js';
import { databaseHostClass } from '../../db/knex.js';
import { dialectOf } from '../../db/dialect.js';
import { instanceIdentity } from '../../observability/path-header.js';
import { currentContext, markOutcome } from '../../observability/request-context.js';
import { platformMode } from '../../platform/mode.js';
import { mediaUrls } from '../../services/media-url.js';
import { probeErrorBody, probeErrorOf, probeErrorStatus } from '../middleware/atl-probe.js';
import { markConfigVersion } from './capabilities.js';

const NO_STORE = 'private, no-store';

function fail(res: Response, status: number, code: string, message: string): void {
  res.status(status).set('Cache-Control', NO_STORE).json({ error: { code, message } });
}

/** 只给探测主体：平台模式关闭 → 404；不是 atl-probe → 401（或 503 PROBE_STORE_UNAVAILABLE） */
const requireProbe: RequestHandler = (_req, res, next) => {
  const ctx = currentContext();
  if (!ctx?.probePrincipal) {
    const code = probeErrorOf(ctx);
    res.status(probeErrorStatus(code)).set('Cache-Control', NO_STORE).json(probeErrorBody(code));
    return;
  }
  next();
};

function safeInstance(): string {
  return (instanceIdentity().instanceId ?? hostname()).replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 64) || 'local';
}

/** 端口故障 → 503 {ok:false,error}；路径头中对应段的结果为 error（instrument 代理已记录） */
async function guarded(res: Response, fn: () => Promise<Record<string, unknown>>): Promise<void> {
  try {
    const body = await fn();
    res.set('Cache-Control', NO_STORE).json(body);
  } catch (e) {
    const err = e as { code?: string; name?: string; message?: string };
    res.status(503).set('Cache-Control', NO_STORE).json({ ok: false, error: { code: err.code ?? err.name ?? 'PORT_FAILURE', message: err.message ?? String(e) } });
  }
}

/** select now()：两种方言都返回 ISO 毫秒时间 */
async function dbNow(c: Container): Promise<string> {
  if (dialectOf(c.db) === 'postgres') {
    const r = await c.db.raw('select now() as now');
    const v = (r as { rows?: Array<{ now: unknown }> }).rows?.[0]?.now;
    return v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString();
  }
  const rows = (await c.db.raw("select strftime('%Y-%m-%dT%H:%M:%fZ', 'now') as now")) as Array<{ now: string }>;
  return String(rows[0]?.now ?? new Date().toISOString());
}

export function register(app: Express, c: Container): void {
  // 只在平台模式下注册：关闭时这些路径落到 /api/lab 的管理员守卫与 501 兜底之前就返回 404
  app.all('/api/lab/probe/*rest', (req, res, next) => {
    if (!platformMode()) {
      res.status(404).json({ error: 'NOT_FOUND', path: req.path });
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.set('Allow', 'GET');
      fail(res, 405, 'METHOD_NOT_ALLOWED', 'probe endpoints only accept GET');
      return;
    }
    next();
  }, requireProbe);

  app.get('/api/lab/probe/now', async (_req, res) => {
    await guarded(res, async () => {
      // ConfigPort：读运行时热键 featureFlags（路径段 config=<driver>:v<n>）
      void c.runtime.current().featureFlags;
      markConfigVersion(c);
      // 主库：每次都执行，所以 database 段总是出现（不放进 cache-aside 的 loader）
      const now = await dbNow(c);
      const inst = instanceIdentity();
      let hit = true;
      const cached = await c.cache.wrap(`probe:now:${safeInstance()}`, 30, async () => {
        hit = false;
        return { appNow: new Date().toISOString() };
      });
      void cached;
      const db = c.config.db;
      return {
        now, appNow: new Date().toISOString(), nonce: randomBytes(16).toString('base64url'),
        instanceId: inst.instanceId ?? hostname(), az: inst.az ?? 'unknown', cache: { hit: c.cache.meta.driver === 'none' ? false : hit },
        db: { driver: db.DB_DRIVER, hostClass: databaseHostClass(db) },
      };
    });
  });

  app.get('/api/lab/probe/echo', (req: Request, res) => {
    const trusted = isLoopback(req.socket.remoteAddress ?? '');
    const header = (h: string) => req.get(h) ?? null;
    const portHeader = trusted ? req.get('X-CA-Server-Port') : undefined;
    const serverPort = portHeader && /^[0-9]{1,5}$/.test(portHeader) ? Number(portHeader) : req.socket.localPort ?? null;
    res.set('Cache-Control', NO_STORE).json({
      method: req.method,
      host: header('host'),
      proto: header('x-forwarded-proto') ?? req.protocol,
      serverPort,
      entry: currentContext()?.entry ?? 'direct',
      clientIp: req.ip ?? null,
      receivedXForwardedFor: trusted ? (req.get(PLATFORM_HEADERS.receivedXff) ?? null) : null,
      xAmznTraceId: header('x-amzn-trace-id'),
      via: header('via'),
      cfIdPresent: Boolean(header('x-amz-cf-id')),
      hasCookie: Boolean(header('cookie')),
      hasAuthorization: Boolean(header('authorization')),
      headerNames: Object.keys(req.headers).sort(),
    });
  });

  app.get('/api/lab/probe/media-url', async (req, res) => {
    const variant = String(req.query.variant ?? 'thumb_200');
    const visibility = String(req.query.visibility ?? (variant === 'original' ? 'private' : 'public'));
    if (!['thumb_200', 'original'].includes(variant) || !['public', 'private'].includes(visibility)) {
      fail(res, 400, 'PROBE_BAD_REQUEST', 'variant=thumb_200|original, visibility=public|private');
      return;
    }
    await guarded(res, async () => {
      const inst = safeInstance();
      const key = variant === 'original' ? `_probe/${inst}/probe.jpg` : `variants/_probe/${inst}/${variant}.webp`;
      const expiresInSec = 600;
      const url = await mediaUrls(c).url(key, { visibility: visibility as 'public' | 'private', expiresInSec });
      let host: string | null = null;
      let scheme: string | null = null;
      let signed = false;
      try {
        const u = new URL(url, c.config.core.APP_BASE_URL);
        host = u.host;
        scheme = u.protocol.replace(':', '');
        signed = ['sig', 'X-Amz-Signature', 'Signature'].some((p) => u.searchParams.has(p));
      } catch {
        /* 相对路径之外的形式：只返回 url */
      }
      return {
        url, host, scheme, signed, expiresInSec, provider: `storage:${c.storage.meta.driver}`,
        cdn: c.cdn.meta.driver !== 'direct' && host !== null && Boolean(c.cdn.baseUrl) && url.startsWith(c.cdn.baseUrl ?? '\u0000'),
      };
    });
  });

  app.get('/api/lab/probe/kms', async (_req, res) => {
    await guarded(res, async () => {
      const plain = randomBytes(32);
      const context = { app: 'cloudalbum', purpose: 'atl-probe' };
      const aad = { rowId: `probe-${safeInstance()}` };
      const blob = await c.crypto.encrypt(plain, context, aad);
      const back = await c.crypto.decrypt(blob, context, aad);
      if (!back.equals(plain)) throw Object.assign(new Error('decrypt mismatch'), { code: 'KMS_ROUNDTRIP_MISMATCH' });
      const outcome = currentContext()?.path.get('kms') ?? '';
      return { driver: c.crypto.meta.driver, keyRef: blob.keyRef, cache: outcome.endsWith(':cache-hit') ? 'hit' : 'miss' };
    });
  });

  app.get('/api/lab/probe/auth', async (_req, res) => {
    await guarded(res, async () => {
      const pub = c.auth.publicConfig() as unknown as Record<string, unknown>;
      const jwks = c.auth.jwks();
      const kids = (jwks?.keys ?? []).map((k) => k.kid).filter((k): k is string => typeof k === 'string');
      markOutcome('auth', c.auth.meta.driver === 'local' ? 'verify' : String(pub.loginMode ?? 'sdk'));
      return {
        driver: c.auth.meta.driver, loginMode: pub.loginMode ?? null, kids, jwksAgeSec: null,
        userPoolId: typeof pub.userPoolId === 'string' ? pub.userPoolId : null,
      };
    });
  });

  app.all('/api/lab/probe/*rest', (_req, res) => {
    fail(res, 404, 'PROBE_UNKNOWN', 'unknown probe endpoint (now, echo, media-url, kms, auth)');
  });
}
