/**
 * waf/false-positive —— 误杀观察（01#waf 第 5 节步骤 3）。合法但“可疑”的正常操作在 count / block 两种模式下的结果：
 *   - 大请求体：模板把 CRS 的 SizeRestrictions_BODY 覆盖为 Count（否则 storage=local 的照片上传会被 8 KB 限制拦掉），
 *     所以大请求体应当放行（status≠403），WAF 日志里记一条 COUNT；
 *   - 含 SQL 关键字的正常文本（例如评论 / 搜索里的 `SELECT * FROM`）：block 模式下可能被 SQLi 托管规则误杀。
 * 以管理员身份经 CloudFront 入口发请求（没有 edge 时退回直连）；在 WAF_RULE_ACTION=count 与 block 下各跑一次对比（卡片第 5、6 步）。
 *
 *   npm run exp -- waf --label after --scenario false-positive
 */
import { defineScenario, numParam } from '../_lib/scenario.js';
import { wafTargets, wafSegment } from './lib.js';

export default defineScenario({
  warmupWithRun: false,
  async run(ctx) {
    const { direct, edge } = wafTargets(ctx);
    const base = edge ?? direct;
    const via = edge ? 'edge' : 'direct';
    if (!edge) ctx.note('CloudFront 入口未知：经直连入口观察（WAF 挂在 CloudFront 上，直连不经过它）');
    // admin client (keeps the token + experiment headers), pointed at the edge
    const client = ctx.http(base, { target: via });
    const ruleAction = String((ctx.capabilities.modules?.waf?.data as Record<string, unknown> | undefined)?.ruleAction ?? 'unknown');
    const bodyKb = Math.min(numParam(ctx, 'bodyKb', 20), 64);

    // 1) large but legitimate body: padded login (bad credentials -> 401). SizeRestrictions_BODY is overridden to Count,
    //    so it must NOT be blocked; the finding records the status and whether a waf segment appeared.
    const bigBody = { email: 'reviewer@invalid.test', password: 'x', note: 'A'.repeat(Math.max(1, bodyKb) * 1024) };
    const big = await client.post('/api/auth/login', { route: '/api/auth/login', auth: false, json: bigBody, expect: [200, 400, 401, 403, 413, 429] });

    // 2) legitimate text that looks like SQL (a search / comment a real user might type)
    const sqlText = encodeURIComponent("SELECT * FROM my favourite albums WHERE title = 'summer'");
    const sqlish = await client.get(`/api/public/now?note=${sqlText}`, { route: '/api/public/now', auth: false, expect: [200, 403, 404, 429] });

    if (ctx.phase !== 'measure') return;
    ctx.finding('via', via);
    ctx.finding('ruleAction', ruleAction);
    ctx.finding('largeBody', { bodyKb, status: big.status, blocked: big.status === 403, waf: wafSegment(big) ?? null });
    ctx.finding('sqlKeywordText', { status: sqlish.status, blocked: sqlish.status === 403, waf: wafSegment(sqlish) ?? null });
    ctx.note('大请求体不应被拦截（SizeRestrictions_BODY 已覆盖为 Count）；block 模式下含 SQL 关键字的正常文本可能被 SQLi 规则误杀——'
      + '在 WAF 的 Logs Insights 里 `stats count() by terminatingRuleId, action` 查看是 COUNT 还是 BLOCK');
  },
});
