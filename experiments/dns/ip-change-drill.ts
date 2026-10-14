/**
 * dns/ip-change-drill —— 换 IP 演练（01#dns 第 5 节步骤 1、2）。
 *
 *   npm run exp -- dns --label before --scenario ip-change-drill --fault-via local            # 没有 Route 53（IP / 外部 A 记录）
 *   npm run exp -- dns --label after  --scenario ip-change-drill --fault-via local --upload   # 有 Route 53：演练时 UPSERT 记录
 *
 * 第 0 秒运行器在本机执行 faults/reassociate-eip.sh swap（after 加 --upsert）：分配临时 EIP 并关联到实例，模拟“实例被替换、IP 变化”；
 * 结束时 restore：关联回原 EIP（after 时把记录改回原 IP）并释放临时 EIP——必须恢复，否则基础栈的 EIP 关联与实际不一致。
 * 本脚本每 intervalSec 秒：用旧 IP 链接 http://<旧 IP>/api/health/live 探测一次；有域名时同时向公共解析器（默认 8.8.8.8）查询
 * 记录（等价于 dig +short <域名> @8.8.8.8）并访问 http://<域名>/api/health/live。
 * 发现：旧 IP 链接失败次数、域名链接失败次数、公共解析器返回新 IP 所需秒数、域名链接恢复所需秒数；服务端证据：
 * 经域名请求 /api/lab/echo 时服务端看到的 Host，以及 dns 感知器的解析结果与 Host 分布（不只看客户端）。
 * 平台模式：演练期间平台记录的 target.publicIp 与方案 B 的 IP 证书暂时失效，不要点“检测”（01#dns 第 12 节）。
 */
import { defineScenario, numParam, strParam } from '../_lib/scenario.js';
import { sleep } from '../_lib/util.js';
import { analyzeIpChange, domainOf, eipOf, probeHealth, readDrillState, resolveVia, serverEvidence, type DrillSample } from './lib.js';

export default defineScenario({
  warmupWithRun: false,
  async run(ctx) {
    const domain = domainOf(ctx);
    const oldIp = eipOf(ctx);
    const env = strParam(ctx, 'env', process.env.CLOUDALBUM_ENV ?? 'lab');
    const servers = strParam(ctx, 'resolver', '8.8.8.8').split(',').map((s) => s.trim()).filter(Boolean);
    const intervalMs = numParam(ctx, 'intervalSec', 5) * 1000;
    ctx.finding('targets', { domain: domain || null, oldIp: oldIp || null, resolver: servers });
    if (!oldIp) ctx.note('不知道实例的 EIP：用 --param ip=<EIP> 指定（capabilities 的 ec2.data.publicIpv4 为空）');
    if (!domain) {
      ctx.note(ctx.label === 'before' ? '没有域名：只测旧 IP 链接（有外部 A 记录时用 --param domain= 指定）' : '没有域名：dns 未启用或 capabilities 没有 recordName（--param domain=）');
    }
    const samples: DrillSample[] = [];
    while (!ctx.signal.aborted && ctx.remainingMs() > 0) {
      const t = ctx.elapsedMs() / 1000;
      const state = readDrillState(env);
      const [old, dom, res] = await Promise.all([
        oldIp ? probeHealth(`http://${oldIp}/api/health/live`) : Promise.resolve(undefined),
        domain ? probeHealth(`http://${domain}/api/health/live`) : Promise.resolve(undefined),
        domain ? resolveVia(domain, servers) : Promise.resolve(undefined),
      ]);
      samples.push({
        t: Math.round(t * 10) / 10, oldLinkOk: old ? old.status === 200 : true,
        ...(dom ? { domainOk: dom.status === 200 } : {}), ...(res ? { answers: res.answers } : {}),
        ...(state?.newIp && !state.restoredAt ? { newIp: state.newIp } : {}),
      });
      await sleep(Math.min(intervalMs, Math.max(0, ctx.remainingMs())), ctx.signal);
    }
    const a = analyzeIpChange(samples);
    for (const [k, v] of Object.entries(a)) ctx.finding(k, v);
    ctx.finding('timeline', samples.slice(0, 120));
    const state = readDrillState(env);
    if (a.swapAt === undefined) {
      ctx.note('没有看到演练开始（faults/reassociate-eip.sh 未执行：Windows 默认 --fault-via skip；在 CloudShell / 工作台用 --fault-via local）');
    }
    if (state) ctx.finding('drill', { oldIp: state.oldIp, newIp: state.newIp, upserted: state.upserted ?? false });
    ctx.finding('server', await serverEvidence(ctx, domain));
  },
});
