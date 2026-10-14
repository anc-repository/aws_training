/**
 * dns/weighted-sample —— 加权路由的实际分配比例（01#dns 第 5 节步骤 4）。
 *
 *   scripts/module enable dns --domain <域名> --param RoutingPolicy=weighted --param WeightedSecondaryIp=<第二个 IP>
 *   npm run exp -- dns --label after --scenario weighted-sample --param queries=200 --upload
 *
 * 直接向托管区域的权威名称服务器（NS 记录的地址，等价于 dig @ns-xxx.awsdns-xx.com）查询 queries 次，避开解析器缓存，
 * 统计每个答案出现的比例；再向公共解析器查询同样次数作对照（缓存使比例偏离设定值）。
 */
import { defineScenario, numParam, strParam } from '../_lib/scenario.js';
import { answerShares, authoritativeServers, domainOf, resolveVia, serverEvidence } from './lib.js';

export default defineScenario({
  warmupWithRun: false,
  async run(ctx) {
    const domain = domainOf(ctx);
    if (!domain) {
      ctx.note('没有域名（dns 未启用？）');
      return;
    }
    const queries = numParam(ctx, 'queries', 200);
    const ns = strParam(ctx, 'nameserver', '');
    const auth = ns ? [ns] : await authoritativeServers(domain);
    ctx.finding('nameservers', auth);
    const authAnswers: string[][] = [];
    const publicAnswers: string[][] = [];
    for (let i = 0; i < queries && !ctx.signal.aborted; i += 1) {
      if (auth.length) authAnswers.push((await resolveVia(domain, [auth[i % auth.length]!], 2000)).answers);
      publicAnswers.push((await resolveVia(domain, ['8.8.8.8'], 2000)).answers);
    }
    ctx.finding('authoritative', answerShares(authAnswers));
    ctx.finding('publicResolver', answerShares(publicAnswers));
    ctx.finding('queries', authAnswers.length);
    if (!auth.length) ctx.note('找不到权威名称服务器（--param nameserver=<NS 的 IP>）：只统计公共解析器');
    ctx.finding('server', await serverEvidence(ctx, domain));
  },
});
