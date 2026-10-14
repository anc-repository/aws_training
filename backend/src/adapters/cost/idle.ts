// backend/src/adapters/cost/idle.ts —— 本地“空开提醒”与资源小时预算提醒（cost 的本地实现，06#cost 第 1 节第 3、4 条）
//
// worker 内循环（LockPort 单例 `cost.idle`，每 10 分钟）：某个按小时计费的模块资源已连续启用超过 COST_LOCAL_IDLE_HOURS（默认 4 小时），
// 且这段时间内没有实验运行（lab_runs 的登记、或 lab_metric_rollups 中带 runId 的请求）时，给管理员写站内信并调用 EmailPort，
// 每个资源每天最多一次。资源小时预算（COST_LOCAL_HOURS_BUDGET）到 80% 与 100% 时各提醒一次（每月）。
// 两者都只度量“开了多久”，不涉及价格（D14）。budgets 档照常运行（本地清单与 Budgets 并排）；实例停机时提醒也随之停止（对比点）。
// ec2 基础资源不提醒（L0 本来就一直开着）；提醒建议“练完可以 scripts/module profile apply l0-ec2”。
import { createHash } from 'node:crypto';
import type { Knex } from 'knex';
import type { EmailPort } from '../../ports/email.js';
import type { LockPort } from '../../ports/lock.js';
import type { Logger } from '../../ports/logger.js';
import { insertNotification } from '../../repositories/notifications.js';
import { getMeta, setMeta } from '../../repositories/system-meta.js';
import { listAdmins } from '../../repositories/users.js';
import type { BillingItem, CostEstimate } from './estimate.js';

export const IDLE_LOCK = 'cost.idle';
export const IDLE_INTERVAL_SEC = 600;

export interface IdleReminder {
  kind: 'idle' | 'hours-budget';
  module: string;
  resource: string;
  runningHours?: number;
  idleHours?: number;
  level?: 'warn80' | 'over100';
  message: string;
}

/** 最近一次实验活动的时间（ISO；没有时 null） */
export async function lastLabActivity(db: Knex): Promise<string | null> {
  const run = (await db('lab_runs').max({ at: 'started_at' }).first()) as { at?: string | null } | undefined;
  const req = (await db('lab_metric_rollups').whereNotNull('run_id').max({ at: 'minute' }).first()) as { at?: string | null } | undefined;
  const xs = [run?.at, req?.at].filter((x): x is string => Boolean(x)).sort();
  return xs.length ? xs[xs.length - 1]! : null;
}

/** 当前应当提醒的空开资源与预算（纯计算；去重由调用方处理） */
export function idleCandidates(est: CostEstimate, opts: { idleHours: number; lastActivity: string | null; now: Date }): IdleReminder[] {
  const out: IdleReminder[] = [];
  const sinceActivityH = opts.lastActivity ? (opts.now.getTime() - Date.parse(opts.lastActivity)) / 3600_000 : Infinity;
  for (const it of est.hourly) {
    if (it.module === 'ec2' || it.module === 'platform' || it.runningHours === null) continue;
    if (it.runningHours < opts.idleHours || sinceActivityH < opts.idleHours) continue;
    out.push({
      kind: 'idle', module: it.module, resource: it.resource, runningHours: round1(it.runningHours),
      ...(Number.isFinite(sinceActivityH) ? { idleHours: round1(sinceActivityH) } : {}),
      message: idleMessage(it, sinceActivityH, opts.idleHours),
    });
  }
  if (est.hoursBudget && est.hoursBudget.level !== 'ok') {
    out.push({
      kind: 'hours-budget', module: 'cost', resource: '资源小时预算', level: est.hoursBudget.level,
      message: `本月已用 ${est.hoursBudget.used} 资源小时，达到资源小时预算 ${est.hoursBudget.limit} 的 ${est.hoursBudget.pct}%（只度量“开了多久”，不是金额）`,
    });
  }
  return out;
}

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}

function idleMessage(it: BillingItem, sinceActivityH: number, idleHours: number): string {
  const name = it.resource.split('（')[0]!.trim();
  const last = Number.isFinite(sinceActivityH) ? `最近 ${Math.floor(sinceActivityH)} 小时没有实验` : '还没有做过实验';
  return `${name}（${it.module}）已启用 ${Math.floor(it.runningHours ?? 0)} 小时，${last}（阈值 ${idleHours} 小时）。练完可以 scripts/module profile apply l0-ec2 或 scripts/module disable ${it.module}`;
}

function dedupKey(r: IdleReminder, now: Date): { key: string; value: string } {
  const h = createHash('sha256').update(`${r.module}|${r.resource}`).digest('hex').slice(0, 16);
  return r.kind === 'idle'
    ? { key: `cost.idle.reminded.${h}`, value: now.toISOString().slice(0, 10) }               // 每个资源每天一次
    : { key: `cost.hours-budget.${now.toISOString().slice(0, 7)}`, value: r.level ?? '' };   // 每月每个级别一次
}

export interface IdleLoopDeps {
  db: Knex;
  estimate: () => CostEstimate;
  idleHours: number;
  lock?: LockPort;
  email?: EmailPort;
  logger?: Pick<Logger, 'info' | 'warn'>;
  appBaseUrl?: string;
  now?: () => Date;
}

/** 一轮检查：返回本轮发出的提醒 */
export async function runIdleCheck(d: IdleLoopDeps): Promise<IdleReminder[]> {
  const now = d.now?.() ?? new Date();
  const est = d.estimate();
  const candidates = idleCandidates(est, { idleHours: d.idleHours, lastActivity: await lastLabActivity(d.db), now });
  const sent: IdleReminder[] = [];
  for (const r of candidates) {
    const k = dedupKey(r, now);
    const prev = await getMeta(d.db, k.key);
    if (r.kind === 'idle' ? prev === k.value : prev === k.value || (prev === 'over100' && k.value === 'warn80')) continue;
    await setMeta(d.db, k.key, k.value);
    const title = r.kind === 'idle' ? `【费用提醒】${r.resource.split('（')[0]} 长时间空开` : '【费用提醒】资源小时预算';
    const admins = await listAdmins(d.db);
    for (const a of admins) {
      await insertNotification(d.db, {
        eventId: `ci:${createHash('sha256').update(`${k.key}|${k.value}|${a.id}`).digest('hex').slice(0, 40)}`, userId: a.id, type: 'cost.idle',
        title, body: `${r.message}\n（本地估算：按 registry 计费维度 × 启用时长，不是账单）`, link: '/lab/m/cost', data: { module: r.module, kind: r.kind },
      });
    }
    const to = admins.map((a) => a.email).filter(Boolean);
    if (d.email && to.length) {
      await d.email.send({
        to, subject: title, category: 'system', tags: { module: 'cost', kind: r.kind },
        text: `${r.message}\n\n${d.appBaseUrl ? `${d.appBaseUrl.replace(/\/$/, '')}/lab/m/cost\n` : ''}（此邮件由 CloudAlbum 本地费用估算发出；实例停机时不会发出）`,
      }).catch((e: unknown) => d.logger?.warn('cost.idle email failed', { error: (e as Error).message }));
    }
    d.logger?.info('cost.idle.reminder', { module: r.module, kind: r.kind, resource: r.resource });
    sent.push(r);
  }
  return sent;
}

/** worker 内循环（集成阶段在 worker.ts 中调用）：每 10 分钟一次，LockPort 单例 */
export function startCostIdleLoop(d: IdleLoopDeps, signal?: AbortSignal, intervalSec = IDLE_INTERVAL_SEC): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const tick = async () => {
    if (stopped) return;
    try {
      const lease = d.lock ? await d.lock.tryAcquire(IDLE_LOCK, intervalSec) : { release: async () => undefined };
      if (lease) {
        try {
          await runIdleCheck(d);
        } finally {
          await lease.release().catch(() => undefined);
        }
      }
    } catch (e) {
      d.logger?.warn('cost.idle check failed', { error: (e as Error).message });
    }
    if (!stopped) {
      timer = setTimeout(() => void tick(), intervalSec * 1000);
      timer.unref?.();
    }
  };
  timer = setTimeout(() => void tick(), 30_000);
  timer.unref?.();
  const stop = () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
  signal?.addEventListener('abort', stop, { once: true });
  return stop;
}
