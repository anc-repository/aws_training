/**
 * iam/whoami —— 凭证来源对照（02#iam 第 5 节步骤 1；任务中的“credential-source”）。
 *
 *   npm run exp -- iam --label before --scenario whoami     # none
 *   npm run exp -- iam --label keys   --scenario whoami     # 反面教材
 *   npm run exp -- iam --label after  --scenario whoami     # role
 *   npm run exp:report -- iam --experiment whoami --pair keys,after
 *
 * 不在实验机上调用 AWS（experiments 不引入 @aws-sdk/*）：身份由服务端的 `GET /api/lab/iam/whoami`（仅管理员，内部
 * GetCallerIdentity）给出，凭证形态来自 capabilities 的 iam 段，已加载的 SDK 来自 `/api/lab/self-check`。
 * 只记录 ARN、访问密钥前 4 位（AKIA / ASIA）与过期时间，不记录密钥本身。
 */
import { defineScenario } from '../_lib/scenario.js';

interface WhoAmI {
  arn?: string;
  account?: string;
  accessKeyId?: string;
  accessKeyPrefix?: string;
  keyPrefix?: string;
  expiration?: string;
  expiresAt?: string;
  source?: string;
}

export default defineScenario({
  warmupWithRun: false,
  async run(ctx) {
    const iam = ctx.capabilities.modules?.iam;
    const driver = iam?.driver ?? 'unknown';
    const data = (iam?.data ?? {}) as Record<string, unknown>;
    ctx.finding('driver', driver);
    ctx.finding('status', iam?.status);
    ctx.finding('detail', iam?.detail);

    const who = await ctx.client.get('/api/lab/iam/whoami', { route: '/api/lab/iam/whoami', expect: [200, 404, 501, 503] });
    let w: WhoAmI = {};
    if (who.status === 200) w = who.json<WhoAmI>();
    else ctx.note(`/api/lab/iam/whoami 返回 ${who.status}：身份只取 capabilities 的 iam 段`);
    const arn = w.arn ?? (typeof data.arn === 'string' ? data.arn : undefined) ?? (typeof data.callerArn === 'string' ? data.callerArn : undefined);
    const prefix = (w.accessKeyPrefix ?? w.keyPrefix ?? w.accessKeyId ?? (typeof data.accessKeyPrefix === 'string' ? data.accessKeyPrefix : undefined))?.slice(0, 4);
    const exp = w.expiration ?? w.expiresAt ?? (typeof data.expiration === 'string' ? data.expiration : undefined);
    const source = driver === 'none' ? 'none' : driver === 'keys' || prefix === 'AKIA' ? 'static-keys' : driver === 'role' || prefix === 'ASIA' ? 'instance-profile' : 'unknown';
    ctx.finding('credentialSource', source);
    ctx.finding('arn', arn);
    ctx.finding('keyPrefix', prefix);
    ctx.finding('expiresAt', exp);
    ctx.finding('expiresInSec', exp ? Math.round((Date.parse(exp) - Date.now()) / 1000) : undefined);

    const self = await ctx.client.get('/api/lab/self-check', { route: '/api/lab/self-check', expect: [200, 404, 501] });
    if (self.status === 200) {
      const b = self.json<{ ok?: boolean; awsSdk?: { loaded?: string[] } }>();
      ctx.finding('awsSdkLoaded', b.awsSdk?.loaded?.length ?? 0);
      ctx.finding('awsSdkPackages', b.awsSdk?.loaded ?? []);
      ctx.finding('selfCheckOk', b.ok === true ? 1 : 0);
    }
    const warnings = [...(ctx.capabilities.validation?.warnings ?? []), ...(ctx.capabilities.validation?.errors ?? [])]
      .filter((f) => /^CRED-/.test(f.rule)).map((f) => `${f.rule}: ${f.message}`);
    ctx.finding('credentialWarnings', warnings.length);
    ctx.finding('credentialFindings', warnings);
    ctx.finding('longTermKeysOnDisk', source === 'static-keys' || warnings.some((x) => x.startsWith('CRED-002')) ? 1 : 0);
  },
});
