/**
 * experiments/waf/lib.ts —— waf 实验共用（01#waf 第 5 节）。
 *
 * 两条入口（取值顺序与 cdn/targets.ts 相同：--param > capabilities 管理员视图 > 运行器目标）：
 *   direct —— EC2 的 Nginx（limit_req + 正则 + denylist）；WAF_MODE=aws 时直连入口需对实验机开放（CDN_DIRECT_ACCESS=admin-ip）
 *   edge   —— CloudFront（AWS WAF 挂载点）；WAF_MODE=aws 时经它的请求带 x-amzn-waf-cloudalbum
 * 服务端证据不看客户端响应头，而用 /api/lab/waf/origin?run=&nonce=：被 AWS WAF 在边缘拦截的请求根本不会出现在源站日志里
 * （04 文档；卡片检查“源站 nonce 计数为 0”）。攻击流量是匿名的（不带实验头 / 令牌，否则独立模式 403），只带一个 nonce 查询参数，
 * 源站日志按 nonce 计数（nginx-log-summary / /api/lab/waf/origin 的 nonce 规则对探测与匿名流量都计数）。
 * 轮次短（PM-M05）：rate 只需略高于速率规则阈值，duration 以秒计；运行器 / 卡片用 --param 控制总时长，不做洪泛式压测。
 */
import type { ExpClient } from '../_lib/http.js';
import type { ScenarioContext } from '../_lib/scenario.js';
import { strParam } from '../_lib/scenario.js';

function str(v: unknown): string | undefined {
  return typeof v === 'string' && /^https?:\/\//.test(v) ? v.replace(/\/+$/, '') : undefined;
}

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

export interface WafTargets { direct: string; edge?: string }

/** direct = EC2 Nginx 入口；edge = CloudFront（AWS WAF 挂载点）。 */
export function wafTargets(ctx: Pick<ScenarioContext, 'params' | 'capabilities' | 'target'>): WafTargets {
  const cdn = ctx.capabilities.modules?.cdn;
  const cdnPub = rec(cdn?.public);
  const cdnData = rec(cdn?.data);
  const entry = ctx.capabilities.app?.entry;
  const edge = str(strParam(ctx, 'edge', '')) ?? str(strParam(ctx, 'cdn', ''))
    ?? str(cdnPub.baseUrl) ?? str(cdnData.baseUrl) ?? (entry?.source === 'cdn' ? str(entry.baseUrl) : undefined);
  const direct = str(strParam(ctx, 'direct', '')) ?? str(cdnData.originDirectUrl) ?? str(cdnPub.originDirectUrl) ?? ctx.target;
  return edge && edge !== direct ? { direct, edge } : { direct };
}

/** IPv4 地址是否落在 CIDR 内（只支持 IPv4；无法解析时 false） */
export function ipv4InCidr(ip: string, cidr: string): boolean {
  const toInt = (a: string): number | undefined => {
    const parts = a.trim().split('.');
    if (parts.length !== 4 || parts.some((p) => !/^\d{1,3}$/.test(p) || Number(p) > 255)) return undefined;
    return parts.reduce((n, p) => n * 256 + Number(p), 0);
  };
  const [net, bitsText] = cidr.trim().split('/');
  const bits = bitsText === undefined ? 32 : Number(bitsText);
  const a = toInt(ip.replace(/^::ffff:/i, ''));
  const b = toInt(net ?? '');
  if (a === undefined || b === undefined || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const size = 2 ** (32 - bits);
  return Math.floor(a / size) === Math.floor(b / size);
}

/** cdn 的直连策略（管理员视图的 capabilities data：open | admin-ip | closed，admin-ip 时附 adminCidr） */
export function directAccessOf(ctx: Pick<ScenarioContext, 'capabilities'>): { mode?: string; adminCidr?: string } {
  const data = rec(ctx.capabilities.modules?.cdn?.data);
  const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  const mode = text(data.directAccess);
  const adminCidr = text(data.adminCidr);
  return { ...(mode ? { mode } : {}), ...(adminCidr ? { adminCidr } : {}) };
}

/** 本次运行的 nonce（源站日志按它计数）；只用 runId 的字符，满足 ^[A-Za-z0-9_-]{8,64}$ */
export function runNonce(ctx: Pick<ScenarioContext, 'runId'>): string {
  return `waf-${ctx.runId}`.slice(0, 64);
}

/** 匿名攻击客户端（不带令牌与实验头）；每个请求带 ?atlprobe=<nonce> 以便源站按 nonce 计数 */
export function attackClient(ctx: Pick<ScenarioContext, 'http'>, base: string, target: 'direct' | 'edge'): ExpClient {
  return ctx.http(base, { target, auth: false, experiment: false });
}

/** 把 nonce 作为 atlprobe 查询参数附加到路径上 */
export function withNonce(path: string, nonce: string): string {
  return `${path}${path.includes('?') ? '&' : '?'}atlprobe=${encodeURIComponent(nonce)}`;
}

export interface OriginSummary {
  logPresent: boolean;
  requests: number;
  byStatus: Record<string, number>;
  byPort: Record<string, number>;
  viaCloudfront: number;
  direct: number;
  nonce?: { value: string; count: number; ports: number[] };
}

/** 管理员端点 /api/lab/waf/origin：按本次 runId 与 nonce 读源站日志（服务端证据）。不可用时返回 undefined。 */
export async function originEvidence(admin: ExpClient, runId: string, nonce: string): Promise<OriginSummary | undefined> {
  const res = await admin.get(`/api/lab/waf/origin?run=${encodeURIComponent(runId)}&nonce=${encodeURIComponent(nonce)}`, { route: '/api/lab/waf/origin', record: false });
  return res.ok ? res.json<OriginSummary>() : undefined;
}

/** `waf=` 段：响应头 X-CloudAlbum-Path 的 waf 段（Nginx 的 ratelimit/badinput/denylist，或 WAF 的 block-<rule>） */
export function wafSegment(res: { headers: Record<string, string> }): string | undefined {
  const h = res.headers['x-cloudalbum-path'];
  if (!h) return undefined;
  for (const part of h.split(';')) {
    const [k, v] = part.split('=');
    if (k?.trim() === 'waf') return v?.trim();
  }
  return undefined;
}
