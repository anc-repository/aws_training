// backend/src/http/middleware/atl-probe.ts —— ATL 平台的只读探测主体 atl-probe 与探测流量标记（06 PM-09、PM-10）
//
// 排在 auth.ts 之前；平台模式关闭时什么都不做（X-ATL-* 头被忽略，端点 /api/lab/probe/* 也不存在）。
// - X-ATL-Probe-Token = atlpk1.*（本机令牌）：与本机密钥常量时间相等，且请求来自回环地址（req.ip）并经直连入口
//   （Nginx 的入口段为 nginx，或直接到达应用端口）；经 8080（cdn）或 ALB 到达的一律不接受 → PROBE_LOCAL_ONLY。
// - X-ATL-Probe-Token = atlpt1.*（一次性令牌）：签名、时间窗、nonce 只用一次（atl_probe_nonces；重放 → PROBE_TOKEN_REPLAYED；
//   数据库不可用 → PROBE_STORE_UNAVAILABLE）；来源不限。
// - X-ATL-Probe-Nonce：只把请求标记为探测流量，不授予任何权限。
// 令牌无效时不在这里拒绝：错误码记在 ctx.locals.probeError，由需要 atl-probe 的端点（/api/lab/probe/*、capabilities 管理员视图）
// 返回 401；其余路由按匿名用户处理。持有有效令牌的主体每分钟最多 120 个请求（超出 429 RATE_LIMITED）。
import type { Request, RequestHandler } from 'express';
import { PLATFORM_HEADERS, PROBE_NONCE_RE } from '@cloudalbum/contracts';
import type { Container } from '../../container.js';
import { isLoopback } from '../../config/net.js';
import { instanceIdentity } from '../../observability/path-header.js';
import { currentContext, type RequestContext } from '../../observability/request-context.js';
import { platformMode, readLocalProbeSecret } from '../../platform/mode.js';
import { tokenKind, verifyLocalToken, verifyProbeToken } from '../../platform/probe-token.js';
import { registerNonce } from '../../repositories/atl-probe-nonces.js';

export const PROBE_RATE_PER_MIN = 120;

export type ProbeError = 'PROBE_TOKEN_MISSING' | 'PROBE_TOKEN_INVALID' | 'PROBE_TOKEN_EXPIRED' | 'PROBE_LOCAL_ONLY'
  | 'PROBE_TOKEN_REPLAYED' | 'PROBE_STORE_UNAVAILABLE';

/** 错误码 → HTTP 状态 */
export function probeErrorStatus(code: ProbeError): number {
  return code === 'PROBE_STORE_UNAVAILABLE' ? 503 : 401;
}

const PROBE_ERROR_MESSAGES: Record<ProbeError, string> = {
  PROBE_TOKEN_MISSING: '需要 X-ATL-Probe-Token（平台探测主体 atl-probe）',
  PROBE_TOKEN_INVALID: '探测令牌无效',
  PROBE_TOKEN_EXPIRED: '一次性探测令牌已过期',
  PROBE_LOCAL_ONLY: '本机令牌只接受来自回环地址、经直连入口的请求',
  PROBE_TOKEN_REPLAYED: '一次性探测令牌已经使用过',
  PROBE_STORE_UNAVAILABLE: '探测令牌登记表不可用（数据库）',
};

export function probeErrorBody(code: ProbeError): { error: { code: string; message: string } } {
  return { error: { code, message: PROBE_ERROR_MESSAGES[code] } };
}

/** 本次请求的探测错误（没有令牌时为 PROBE_TOKEN_MISSING） */
export function probeErrorOf(ctx: RequestContext | undefined): ProbeError {
  const e = ctx?.locals.probeError;
  return typeof e === 'string' ? (e as ProbeError) : 'PROBE_TOKEN_MISSING';
}

/** 请求是否来自回环地址并经直连入口（PM-09 本机令牌的第 3、4 条） */
export function isLocalDirect(req: Request, ctx: RequestContext): boolean {
  const ip = req.ip ?? req.socket.remoteAddress ?? '';
  if (!isLoopback(ip)) return false;
  // ctx.entry 只在 TCP 对端是回环地址时取自 Nginx 的 X-CloudAlbum-Entry；没有 = 直接请求应用端口
  return ctx.entry === undefined || ctx.entry === 'nginx';
}

/** 探测请求计数（cloudalbum_atl_probe_requests_total{kind}） */
export class ProbeCounters {
  readonly totals: Record<'local' | 'otp' | 'nonce', number> = { local: 0, otp: 0, nonce: 0 };
  inc(kind: 'local' | 'otp' | 'nonce'): void {
    this.totals[kind] += 1;
  }
  any(): boolean {
    return this.totals.local + this.totals.otp + this.totals.nonce > 0;
  }
  prometheus(role: string): string[] {
    if (!this.any()) return [];
    return [
      '# HELP cloudalbum_atl_probe_requests_total ATL platform probe requests (excluded from lab metrics, 06 PM-10)',
      '# TYPE cloudalbum_atl_probe_requests_total counter',
      ...(['local', 'otp', 'nonce'] as const).map((k) => `cloudalbum_atl_probe_requests_total{role="${role}",kind="${k}"} ${this.totals[k]}`),
    ];
  }
}

export const probeCounters = new ProbeCounters();

export function atlProbe(c: Container): RequestHandler {
  const minuteCounts = { minute: -1, count: 0 };
  return async (req, res, next) => {
    if (!platformMode()) return next();
    const ctx = currentContext();
    if (!ctx) return next();
    const nonce = req.get(PLATFORM_HEADERS.probeNonce);
    if (nonce && PROBE_NONCE_RE.test(nonce)) ctx.probe = 'nonce';
    const token = req.get(PLATFORM_HEADERS.probeToken);
    if (!token) {
      if (ctx.probe) probeCounters.inc(ctx.probe);
      return next();
    }
    const kind = tokenKind(token.trim());
    let error: ProbeError | undefined;
    if (kind === 'local') {
      if (!verifyLocalToken(token.trim(), readLocalProbeSecret())) error = 'PROBE_TOKEN_INVALID';
      else if (!isLocalDirect(req, ctx)) error = 'PROBE_LOCAL_ONLY';
    } else if (kind === 'otp') {
      const v = verifyProbeToken(token.trim(), readLocalProbeSecret());
      if (!v.ok) error = v.code;
      else {
        try {
          const first = await registerNonce(c.db, { nonce: v.nonce, exp: v.exp, instanceId: instanceIdentity().instanceId ?? null });
          if (!first) error = 'PROBE_TOKEN_REPLAYED';
        } catch {
          error = 'PROBE_STORE_UNAVAILABLE';
        }
      }
    } else {
      error = 'PROBE_TOKEN_INVALID';
    }
    if (error) {
      ctx.locals.probeError = error;
      if (ctx.probe) probeCounters.inc(ctx.probe);
      return next();
    }
    ctx.probe = kind as 'local' | 'otp';
    ctx.probePrincipal = true;
    probeCounters.inc(ctx.probe);
    // 应用层限速：atl-probe 每分钟最多 120 个请求（本进程计数）
    const minute = Math.floor(Date.now() / 60_000);
    if (minuteCounts.minute !== minute) { minuteCounts.minute = minute; minuteCounts.count = 0; }
    minuteCounts.count += 1;
    if (minuteCounts.count > PROBE_RATE_PER_MIN) {
      res.status(429).set('Cache-Control', 'private, no-store')
        .json({ error: { code: 'RATE_LIMITED', message: `atl-probe 每分钟最多 ${PROBE_RATE_PER_MIN} 个请求` } });
      return;
    }
    next();
  };
}
