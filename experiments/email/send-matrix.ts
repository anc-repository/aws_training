/**
 * email/send-matrix —— 发信矩阵（04#email 第 5 节步骤 1、3）。
 *
 *   npm run exp -- email --label before --scenario send-matrix [--param to=<你已验证的邮箱>]
 *   scripts/module enable email --param Email=<你的邮箱>          # 到邮箱点击 AWS 的验证链接
 *   npm run exp -- email --label after  --scenario send-matrix [--param to=<你已验证的邮箱>]
 *
 * 地址：SES 邮箱模拟器 success@ / bounce@ / complaint@simulator.amazonses.com（沙盒中也能用，不损害发件信誉），外加可选的你自己的已验证地址。
 * 对每个地址走正常的业务路径：注册测试用户（已注册则跳过）→ POST /api/auth/forgot 触发一封“重置密码”（必要邮件，抑制状态下也会发）。
 * 然后以管理员身份轮询 /api/admin/outbox（服务端证据：status、transport、delivery_status 由反馈队列更新），记录：
 *   - 发送调用的耗时（forgot 请求的 Server-Timing email 段；QUEUE_DRIVER=sync 时在请求内）；
 *   - 最终投递状态：outbox 档全部是“写入 outbox、未真正发出”；ses 档 success → 已投递、bounce → 退信、complaint → 投诉；
 *   - 反馈回流延迟（从请求返回到看到 delivery_status 变化，按轮询间隔计）。
 * 只适用于 auth=local（cognito 档的重置密码邮件由 Cognito 发送，不经过 EmailPort）。
 */
import { randomBytes } from 'node:crypto';
import type { ExpClient } from '../_lib/http.js';
import { defineScenario, numParam, strParam } from '../_lib/scenario.js';
import { percentile, round1, sleep } from '../_lib/util.js';

export const SIMULATOR = {
  success: 'success@simulator.amazonses.com',
  bounce: 'bounce@simulator.amazonses.com',
  complaint: 'complaint@simulator.amazonses.com',
} as const;

export interface OutboxSummary {
  id: string; messageId: string; to: string[]; category: string; transport: string; status: string; deliveryStatus: string;
  error: string | null; createdAt: string; sentAt: string | null;
}

/** 管理员视角：某地址最近一封指定类别的邮件 */
export async function latestMail(client: ExpClient, to: string, category: string, since?: string): Promise<OutboxSummary | undefined> {
  const r = await client.get(`/api/admin/outbox?to=${encodeURIComponent(to)}&category=${encodeURIComponent(category)}&limit=5`, { route: '/api/admin/outbox', record: false });
  if (!r.ok) return undefined;
  const items = r.json<{ items?: OutboxSummary[] }>().items ?? [];
  return items.find((m) => !since || m.createdAt >= since);
}

const FINAL = new Set(['delivered', 'bounced', 'complained', 'rejected']);

export default defineScenario({
  warmupWithRun: false,
  async run(ctx) {
    const driver = String(ctx.capabilities.modules?.email?.driver ?? 'unknown');
    const auth = String(ctx.capabilities.modules?.auth?.driver ?? 'local');
    ctx.finding('driver', driver);
    if (auth !== 'local') ctx.note(`auth=${auth}：重置密码邮件由 Cognito 发送，不经过 EmailPort；本场景只记录发送请求`);
    const own = strParam(ctx, 'to', '');
    const addresses = [SIMULATOR.success, SIMULATOR.bounce, SIMULATOR.complaint, ...(own ? [own.toLowerCase()] : [])];
    const waitSec = numParam(ctx, 'waitSec', driver === 'ses' ? 180 : 3);
    const sent: Array<{ to: string; at: number; since: string; emailMs?: number; status: number }> = [];
    for (const to of addresses) {
      // 测试用户（已存在时 409）
      await ctx.client.post('/api/auth/register', {
        route: '/api/auth/register', auth: false, expect: [201, 409, 429],
        json: { email: to, password: `Sm-${randomBytes(9).toString('base64url')}-7z`, displayName: to.split('@')[0] },
      });
      const since = new Date(Date.now() - 1000).toISOString();
      const r = await ctx.client.post('/api/auth/forgot', { route: '/api/auth/forgot', auth: false, json: { email: to }, expect: [200, 202, 204, 429] });
      if (r.status === 429) ctx.note(`${to}：/api/auth/forgot 被限速（每地址 15 分钟 5 次），稍后重试`);
      sent.push({ to, at: Date.now(), since, status: r.status, emailMs: r.serverTiming.find((m) => m.name === 'email')?.dur });
    }

    const result: Record<string, { transport?: string; status?: string; deliveryStatus?: string; error?: string | null; feedbackSec?: number }> = {};
    const deadline = Date.now() + waitSec * 1000;
    const pending = new Set(addresses);
    do {
      for (const s of sent) {
        if (!pending.has(s.to)) continue;
        const m = await latestMail(ctx.client, s.to, 'password-reset', s.since);
        if (!m) continue;
        result[s.to] = { transport: m.transport, status: m.status, deliveryStatus: m.deliveryStatus, error: m.error };
        const final = m.transport !== 'ses' || m.status === 'failed' || FINAL.has(m.deliveryStatus);
        if (final) {
          if (m.transport === 'ses' && FINAL.has(m.deliveryStatus)) result[s.to]!.feedbackSec = round1((Date.now() - s.at) / 1000);
          pending.delete(s.to);
        }
      }
      if (!pending.size) break;
      await sleep(3000, ctx.signal);
    } while (Date.now() < deadline && !ctx.signal.aborted);
    ctx.finding('results', result);
    ctx.finding('waitingForFeedback', [...pending]);
    const emailMs = sent.map((s) => s.emailMs).filter((x): x is number => x !== undefined);
    ctx.finding('emailMsP50', round1(percentile(emailMs, 50)));
    ctx.business('email_send_ms_p50', percentile(emailMs, 50));
    const count = (pred: (v: (typeof result)[string]) => boolean) => Object.values(result).filter(pred).length;
    ctx.business('mail_delivered', count((v) => v.deliveryStatus === 'delivered'));
    ctx.business('mail_bounced', count((v) => v.deliveryStatus === 'bounced'));
    ctx.business('mail_complained', count((v) => v.deliveryStatus === 'complained'));
    ctx.business('mail_outbox_only', count((v) => v.transport === 'outbox'));
    ctx.business('mail_failed', count((v) => v.status === 'failed'));
    const fb = Object.values(result).map((v) => v.feedbackSec).filter((x): x is number => x !== undefined);
    ctx.business('feedback_latency_sec_max', fb.length ? Math.max(...fb) : undefined);
  },
});
