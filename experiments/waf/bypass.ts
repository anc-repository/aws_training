/**
 * waf/bypass —— 源站锁定验证（01#waf 第 5 节步骤 4）。直接请求 EC2 的公网入口（直连端口与 8080），看源站是否只接受 CloudFront：
 *   - 源站未锁定（CDN_DIRECT_ACCESS=open）：直连可达 → 攻击者可以绕过 CloudFront 上的 WAF（DEP-018 的现象）；
 *   - 锁定后（admin-ip / closed）：直连对非白名单地址拒绝 / 超时；8080 要求合法 X-Origin-Verify，不带则 403。
 * 不发攻击载荷，只各发一个探测请求。只请求自己账号里的实例。
 * CDN_DIRECT_ACCESS=admin-ip 时直连只对 CDN_ADMIN_CIDR 开放，而卡片把它设为工作台的公网出口，所以从工作台运行时直连必然可达。
 * 这时用服务端证据区分（wave1-integration）：经直连请求 /api/lab/echo 得到源站看到的客户端地址，与 capabilities 中 cdn 的 adminCidr
 * 比较；落在白名单内记 directAllowedAsAdmin=true，不算“未锁定”（从其他地址直连会被安全组拒绝，卡片另有 CloudShell 手动验证）。
 *
 *   npm run exp -- waf --label before --scenario bypass   # 启用 WAF 前（源站未锁定）
 *   npm run exp -- waf --label after  --scenario bypass   # 锁定后
 */
import { defineScenario, strParam } from '../_lib/scenario.js';
import { timedGet } from '../_lib/probe.js';
import { directAccessOf, ipv4InCidr, runNonce, wafTargets, withNonce } from './lib.js';

/** 把 base（或 host 参数）归一化为一个 origin，并给出它在 8080 端口上的变体 */
function origins(direct: string, hostParam: string): { base: string; port8080: string } | undefined {
  let u: URL;
  try {
    u = new URL(hostParam ? (/^https?:\/\//.test(hostParam) ? hostParam : `http://${hostParam}`) : direct);
  } catch {
    return undefined;
  }
  const base = `${u.protocol}//${u.host}`;
  const alt = new URL(base);
  alt.port = '8080';
  return { base, port8080: `${alt.protocol}//${alt.host}` };
}

export default defineScenario({
  warmupWithRun: false,
  async run(ctx) {
    const { direct } = wafTargets(ctx);
    const o = origins(direct, strParam(ctx, 'host', ''));
    if (!o) { ctx.note('源站主机未知（capabilities 没有直连地址）'); return; }
    const nonce = runNonce(ctx);
    const probes: Array<{ id: string; url: string; headers?: Record<string, string> }> = [
      { id: 'direct', url: `${o.base}${withNonce('/api/public/now', nonce)}` },
      { id: 'port8080NoKey', url: `${o.port8080}${withNonce('/api/public/now', nonce)}` },
      { id: 'port8080FakeKey', url: `${o.port8080}${withNonce('/api/public/now', nonce)}`, headers: { 'x-origin-verify': 'wrong-value' } },
    ];
    const results: Record<string, { status: number; reachable: boolean; error?: string }> = {};
    for (const p of probes) {
      const r = await timedGet(p.url, p.headers ?? {}, 8000);
      results[p.id] = { status: r.status, reachable: r.status > 0 && r.status !== 403, ...(r.error ? { error: r.error } : {}) };
    }
    if (ctx.phase !== 'measure') return;
    for (const [id, r] of Object.entries(results)) ctx.finding(id, r);
    // 服务端证据：admin-ip 时直连可达，是否只因为运行者在管理 IP 白名单内
    const access = directAccessOf(ctx);
    let directAllowedAsAdmin = false;
    if (results.direct!.reachable && access.mode === 'admin-ip' && access.adminCidr) {
      const echo = await ctx.http(o.base).get('/api/lab/echo', { record: false }).catch(() => undefined);
      const seen = echo?.ok ? echo.json<{ ip?: string | null }>()?.ip ?? undefined : undefined;
      directAllowedAsAdmin = Boolean(seen && ipv4InCidr(seen, access.adminCidr));
      ctx.finding('originSeenClientIp', seen ?? null);
      ctx.finding('adminCidr', access.adminCidr);
    }
    if (access.mode) ctx.finding('directAccess', access.mode);
    ctx.finding('directAllowedAsAdmin', directAllowedAsAdmin);
    const locked = (!results.direct!.reachable || directAllowedAsAdmin) && !results.port8080NoKey!.reachable && !results.port8080FakeKey!.reachable;
    ctx.finding('originLocked', locked);
    ctx.finding('probedOrigin', o.base);
    ctx.note(locked
      ? (directAllowedAsAdmin
        ? `源站已锁定：直连只对管理 IP ${access.adminCidr} 开放（本次从白名单内运行，所以可达；源站看到的客户端地址在白名单内），8080 需合法 X-Origin-Verify —— 其他地址无法绕过 CloudFront 上的 WAF`
        : '源站已锁定：直连不可达、8080 需合法 X-Origin-Verify —— 攻击者无法绕过 CloudFront 上的 WAF')
      : '源站未锁定（直连可达）：攻击者可以绕过 CloudFront 上的 WAF（DEP-018）；用 CDN_DIRECT_ACCESS=admin-ip|closed 收紧');
  },
});
