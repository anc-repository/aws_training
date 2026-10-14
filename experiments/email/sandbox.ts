/**
 * email/sandbox —— SES 沙盒限制（04#email 第 5 节步骤 6）。
 *
 *   npm run exp -- email --label after --scenario sandbox --param to=<一个没有在 SES 验证过的地址>
 *   aws sesv2 get-account --query "{production:ProductionAccessEnabled,quota:SendQuota}"
 *
 * 走正常的业务路径：用该地址注册一个测试用户（已注册时改为 POST /api/auth/resend 重发验证邮件），验证邮件交给 EmailPort。
 * 沙盒中 SES 拒绝发给未验证地址：服务端记录（/api/admin/outbox，服务端证据）为 status=failed、错误 MessageRejected，路径段
 * email=ses:rejected；EMAIL_SANDBOX_POLICY=outbox 时改写进本机 outbox（transport=outbox，同样标注未真正发出）。
 * 同时记录管理员视图 capabilities 中 email 的沙盒状态与配额（来自 GetAccount）。保留域名（example.com 等）不会调用 SES，不要用它们。
 */
import { randomBytes } from 'node:crypto';
import { defineScenario, strParam } from '../_lib/scenario.js';
import { sleep } from '../_lib/util.js';
import { latestMail, type OutboxSummary } from './send-matrix.js';

const RESERVED = /@([a-z0-9.-]+\.)?example\.(com|net|org)$|\.(example|invalid|test|localhost)$/i;

export default defineScenario({
  warmupWithRun: false,
  async run(ctx) {
    const to = strParam(ctx, 'to', '').trim().toLowerCase();
    if (!to.includes('@')) throw new Error('需要 --param to=<一个没有在 SES 验证过的地址>');
    if (RESERVED.test(to)) throw new Error(`${to} 是保留域名：EmailPort 不会为它调用 SES（PM-46），换一个真实但未验证的地址`);
    const driver = String(ctx.capabilities.modules?.email?.driver ?? 'unknown');
    ctx.finding('driver', driver);
    const since = new Date(Date.now() - 1000).toISOString();
    const reg = await ctx.client.post('/api/auth/register', {
      route: '/api/auth/register', auth: false, expect: [201, 409, 429],
      json: { email: to, password: `Sb-${randomBytes(9).toString('base64url')}-4q`, displayName: 'sandbox' },
    });
    let res = reg;
    if (reg.status === 409) res = await ctx.client.post('/api/auth/resend', { route: '/api/auth/resend', auth: false, json: { email: to }, expect: [204, 400, 429] });
    ctx.finding('request', `${reg.status === 409 ? 'resend' : 'register'} → HTTP ${res.status}`);
    ctx.finding('pathSegment', res.path.modules.find((m) => m.module === 'email')?.raw);
    let mail: OutboxSummary | undefined;
    for (let i = 0; i < 10 && !mail; i += 1) {
      mail = await latestMail(ctx.client, to, 'verification', since);
      if (!mail) await sleep(1000, ctx.signal);
    }
    ctx.finding('mail', mail ? { transport: mail.transport, status: mail.status, deliveryStatus: mail.deliveryStatus, error: mail.error } : null);
    const rejected = Boolean(mail && /MessageRejected/.test(mail.error ?? ''));
    ctx.finding('rejected', rejected);
    ctx.business('sandbox_rejected', rejected ? 1 : 0);
    const caps = await ctx.client.get('/api/capabilities', { route: '/api/capabilities', record: false });
    if (caps.ok) {
      const e = caps.json<{ modules?: Record<string, { status?: string; detail?: string; data?: { account?: unknown } }> }>().modules?.email;
      ctx.finding('capability', { status: e?.status, detail: e?.detail, account: e?.data?.account });
    }
    if (driver === 'ses' && mail && !rejected && mail.status === 'sent') {
      ctx.note('邮件没有被拒：这个地址已经验证过，或者账号在本区域已经有生产访问（看 capability.account.production）');
    }
  },
});
