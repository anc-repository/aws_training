/**
 * tls/renew-drill —— 续期演练（01#tls 第 5 节步骤 7）。
 *
 *   npm run exp -- tls --label after --scenario renew-drill --fault-via ssm --upload
 *
 * 第 5 秒经投递通道在实例上执行 faults/renew-drill.sh：hostSetup 的 `renew-drill --force`——certbot renew --dry-run，再
 * --force-renewal（ACME 端点签发新证书；同一 ACME 账户、相同域名与密钥算法时 ACM 中的证书 ARN 不变；按域名计费一次）。
 * 本脚本握手直连入口，记录演练前的序列号与到期时间，轮询直到序列号变化（服务端的新证书真的装进了 Nginx）；
 * 集成证书（CloudFront / ALB）有 AWS CLI 与凭证时读取 aws acm describe-certificate 的 RenewalEligibility、InUseBy 与验证记录状态。
 */
import { spawnSync } from 'node:child_process';
import { defineScenario, numParam } from '../_lib/scenario.js';
import { sleep } from '../_lib/util.js';
import { inspectEntry, serverEvidence, tlsEntries } from './lib.js';

function describeCertificate(arn: string): Record<string, unknown> | undefined {
  const region = /^arn:aws[a-z-]*:acm:([a-z0-9-]+):/.exec(arn)?.[1];
  const r = spawnSync('aws', ['acm', 'describe-certificate', '--certificate-arn', arn, ...(region ? ['--region', region] : []), '--output', 'json'],
    { encoding: 'utf8', timeout: 20_000, windowsHide: true });
  if (r.status !== 0) return undefined;
  try {
    const c = (JSON.parse(r.stdout) as { Certificate?: Record<string, unknown> }).Certificate ?? {};
    return {
      status: c.Status, renewalEligibility: c.RenewalEligibility, inUseBy: c.InUseBy, notAfter: c.NotAfter,
      renewalStatus: (c.RenewalSummary as Record<string, unknown> | undefined)?.RenewalStatus ?? null,
      validation: ((c.DomainValidationOptions as Array<Record<string, unknown>> | undefined) ?? []).map((v) => ({ domain: v.DomainName, status: v.ValidationStatus })),
    };
  } catch {
    return undefined;
  }
}

export default defineScenario({
  warmupWithRun: false,
  async run(ctx) {
    const direct = tlsEntries(ctx).find((e) => e.entry === 'direct');
    const before = direct ? await inspectEntry(direct) : undefined;
    ctx.finding('before', before ? { serial: before.serial, notAfter: before.notAfter, issuer: before.issuer } : null);
    const pollMs = numParam(ctx, 'pollSec', 10) * 1000;
    let after = before;
    let changedAt: number | undefined;
    while (direct && before?.ok && !ctx.signal.aborted && ctx.remainingMs() > 0) {
      await sleep(Math.min(pollMs, Math.max(0, ctx.remainingMs())), ctx.signal);
      after = await inspectEntry(direct);
      if (after.ok && after.serial && after.serial !== before.serial) { changedAt = Math.round(ctx.elapsedMs() / 1000); break; }
    }
    ctx.finding('after', after ? { serial: after.serial, notAfter: after.notAfter, issuer: after.issuer } : null);
    ctx.finding('renewed', Boolean(changedAt));
    ctx.finding('secondsToNewCert', changedAt);
    if (!direct) ctx.note('没有直连入口（--param hosts=direct=<EIP>）');
    else if (!changedAt) ctx.note('演练期间直连证书的序列号没有变化：故障脚本未执行（--fault-via ssh|ssm），或 TLS_ACME=off（Nginx 上不是 ACME 证书）');
    const data = (ctx.capabilities.modules?.tls?.data ?? {}) as Record<string, unknown>;
    const integration: Record<string, unknown> = {};
    for (const [role, arn] of [['edge', data.certArnEdge], ['regional', data.certArnRegional]] as const) {
      if (typeof arn === 'string' && arn) integration[role] = describeCertificate(arn) ?? { note: '需要 AWS CLI 与凭证' };
    }
    if (Object.keys(integration).length) ctx.finding('integration', integration);
    ctx.finding('server', await serverEvidence(ctx));
  },
});
