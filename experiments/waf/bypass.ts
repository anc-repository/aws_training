/**
 * waf/bypass —— 源站锁定验证（01#waf 第 5 节步骤 4）。直接请求 EC2 的公网入口（直连端口与 8080），看源站是否只接受 CloudFront：
 *   - 源站未锁定（CDN_DIRECT_ACCESS=open）：直连可达 → 攻击者可以绕过 CloudFront 上的 WAF（DEP-018 的现象）；
 *   - 锁定后（admin-ip / closed）：直连对非白名单地址拒绝 / 超时；8080 要求合法 X-Origin-Verify，不带则 403。
 * 不发攻击载荷，只各发一个探测请求。只请求自己账号里的实例。
 *
 *   npm run exp -- waf --label before --scenario bypass   # 启用 WAF 前（源站未锁定）
 *   npm run exp -- waf --label after  --scenario bypass   # 锁定后
 */
import { defineScenario, strParam } from '../_lib/scenario.js';
import { timedGet } from '../_lib/probe.js';
import { runNonce, wafTargets, withNonce } from './lib.js';

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
    const locked = !results.direct!.reachable && !results.port8080NoKey!.reachable && !results.port8080FakeKey!.reachable;
    ctx.finding('originLocked', locked);
    ctx.finding('probedOrigin', o.base);
    ctx.note(locked
      ? '源站已锁定：直连不可达、8080 需合法 X-Origin-Verify —— 攻击者无法绕过 CloudFront 上的 WAF'
      : '源站未锁定（直连可达）：攻击者可以绕过 CloudFront 上的 WAF（DEP-018）；用 CDN_DIRECT_ACCESS=admin-ip|closed 收紧');
  },
});
