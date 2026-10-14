// backend/src/adapters/monitoring/alert-evaluator.ts —— 本地告警评估器（monitoring 的本地实现，05#monitoring 第 1 节）
//
// worker 进程内的循环（默认每 30 秒），用 LockPort 取单例锁 `monitoring.alerts`（多实例时只有一个实例在评估）。它与 METRICS_DRIVER
// 无关、始终开启：cloudwatch 档 = local + 批量上报，本地评估器照常工作，两侧可以并排比较。
//   数据源（都在共享数据库里，不读别的进程的内存）：
//     route.count / route.count{status=5xx} / route.latency  ← lab_metric_rollups（LabMetricsStore 每 10 秒落库的分钟汇总）
//     host.memUsedRatio / host.dataVolumeUsedRatio / host.cpuPct ← lab_host_samples（每个进程每 10 秒一次的主机采样）
//     process.heartbeat{role=api|worker}                          ← lab_host_samples 中该角色最近一次采样（进程活着才会写）
//   其他指标（例如 log.events{level=error}，需要 logging 计数）没有本地数据源：状态记为 INSUFFICIENT_DATA。
//   状态变化写入 alert_events（source=local），并通知：给所有管理员写站内信（notifications，type=monitoring.alarm），
//   调用 EmailPort 发给 alertEmail（基线是 outbox；email 模块启用后经 SES 真正发出）。
// 局限（也是对比点）：评估器和被监控的应用在同一台机器上——worker 挂了没人评估，实例挂了没人报警。
// 评估器每次运行后把“最近评估时间、持有者”写入 system_meta（monitoring.alerts.heartbeat），api 进程的探针据此判断评估器是否在运行。
import { createHash } from 'node:crypto';
import os from 'node:os';
import type { Knex } from 'knex';
import { jsonIn } from '../../db/dialect.js';
import { LogHistogram } from '../../observability/lab-metrics.js';
import type { EmailPort } from '../../ports/email.js';
import type { LockPort } from '../../ports/lock.js';
import type { Logger } from '../../ports/logger.js';
import { insertNotification } from '../../repositories/notifications.js';
import { getMeta, setMeta } from '../../repositories/system-meta.js';
import { listAdmins } from '../../repositories/users.js';
import { AlertRulesLoader, alertsFile, compare, type AlarmState, type AlertRule, type AlertRulesFile } from './alert-rules.js';

export const EVALUATOR_LOCK = 'monitoring.alerts';
export const EVALUATOR_META_KEY = 'monitoring.alerts.heartbeat';

export interface RuleResult {
  name: string;
  state: AlarmState;
  value: number | null;
  detail: string;
}

export interface EvaluatorHeartbeat {
  at: string;
  holder: string;
  rules: number;
  intervalSec: number;
  source: string;
}

export interface AlertEvaluatorDeps {
  db: Knex;
  envDir: string;
  lock?: LockPort;
  email?: EmailPort;
  logger?: Pick<Logger, 'info' | 'warn' | 'error'>;
  /** 应用基址（通知中的链接） */
  appBaseUrl?: string;
  now?: () => Date;
  /** 测试：直接给定规则 */
  rules?: () => AlertRulesFile;
  /** 第一轮评估前的等待（默认一个评估周期） */
  firstDelayMs?: number;
}

function minuteFloorIso(ms: number): string {
  const d = new Date(ms);
  d.setUTCSeconds(0, 0);
  return d.toISOString();
}

/** 规则的单次判定（纯数据库查询，不写任何东西） */
export async function evaluateRule(db: Knex, rule: AlertRule, now: Date): Promise<RuleResult> {
  const sinceMs = now.getTime() - rule.windowSec * 1000;
  const sinceIso = new Date(sinceMs).toISOString();
  const verdict = (value: number, what: string): RuleResult => {
    const breach = compare(value, rule.op, rule.threshold);
    return { name: rule.name, state: breach ? 'ALARM' : 'OK', value, detail: `${what} = ${round(value)} ${rule.op} ${rule.threshold}：${breach ? '超过阈值' : '正常'}` };
  };
  const insufficient = (why: string): RuleResult => ({ name: rule.name, state: 'INSUFFICIENT_DATA', value: null, detail: why });

  switch (rule.kind) {
    case 'ratio': {
      if (!isRouteCount(rule.num) || !isRouteCount(rule.den)) return insufficient(`没有本地数据源：${rule.num} / ${rule.den}`);
      const rows = (await db('lab_metric_rollups').where('kind', 'route').andWhere('minute', '>=', minuteFloorIso(sinceMs))
        .select('count', 'status_class')) as Array<{ count: number; status_class: string | null }>;
      const total = rows.reduce((a, r) => a + Number(r.count ?? 0), 0);
      const errors = rows.filter((r) => r.status_class === '5xx').reduce((a, r) => a + Number(r.count ?? 0), 0);
      const num = rule.num === 'route.count' ? total : errors;
      const den = rule.den === 'route.count' ? total : errors;
      // 窗口内没有请求：既没有错误也算不出比率——与 CloudWatch 告警的 TreatMissingData=notBreaching 一致，记为 OK
      if (den === 0) return { name: rule.name, state: 'OK', value: 0, detail: `最近 ${fmtWindow(rule.windowSec)} 没有请求` };
      return verdict(num / den, `${fmtWindow(rule.windowSec)} 内 ${num}/${den}`);
    }
    case 'quantile': {
      if (rule.metric !== 'route.latency') return insufficient(`没有本地数据源：${rule.metric}`);
      const rows = (await db('lab_metric_rollups').where('kind', 'route').andWhere('minute', '>=', minuteFloorIso(sinceMs))
        .select('count', 'sum_ms', 'max_ms', 'hist')) as Array<Record<string, unknown>>;
      const h = new LogHistogram();
      for (const r of rows) h.merge({ counts: jsonIn<number[]>(r.hist, []) ?? [], count: Number(r.count), sum: Number(r.sum_ms), max: Number(r.max_ms) });
      if (!h.count) return { name: rule.name, state: 'OK', value: 0, detail: `最近 ${fmtWindow(rule.windowSec)} 没有请求` };
      return verdict(h.percentile((rule.q ?? 0.95) * 100), `p${Math.round((rule.q ?? 0.95) * 100)}（ms，${h.count} 个请求）`);
    }
    case 'gauge': {
      const col = rule.metric === 'host.memUsedRatio' ? 'mem_used_ratio'
        : rule.metric === 'host.dataVolumeUsedRatio' ? 'data_used_pct'
          : rule.metric === 'host.cpuPct' ? 'cpu_pct' : undefined;
      if (!col) return insufficient(`没有本地数据源：${rule.metric}`);
      const rows = (await db('lab_host_samples').where('ts', '>=', sinceIso).whereNotNull(col)
        .select('instance_id', col)) as Array<Record<string, unknown>>;
      if (!rows.length) return insufficient(`最近 ${fmtWindow(rule.windowSec)} 没有主机采样`);
      // 每台实例取窗口平均，再取最大的一台（主机类指标按实例分散）
      const per = new Map<string, { sum: number; n: number }>();
      for (const r of rows) {
        const v = Number(r[col]) / (col === 'data_used_pct' ? 100 : 1);
        if (!Number.isFinite(v)) continue;
        const k = String(r.instance_id);
        const cur = per.get(k) ?? { sum: 0, n: 0 };
        cur.sum += v;
        cur.n += 1;
        per.set(k, cur);
      }
      if (!per.size) return insufficient(`最近 ${fmtWindow(rule.windowSec)} 没有 ${rule.metric}`);
      let worst = -Infinity;
      let worstId = '';
      for (const [id, { sum, n }] of per) if (sum / n > worst) { worst = sum / n; worstId = id; }
      return verdict(worst, `${rule.metric}（${worstId}，${fmtWindow(rule.windowSec)} 平均）`);
    }
    case 'absent': {
      const role = /^process\.heartbeat\{role=(api|worker)\}$/.exec(rule.metric ?? '')?.[1];
      if (!role) return insufficient(`没有本地数据源：${rule.metric}`);
      const last = (await db('lab_host_samples').where('role', role).max({ ts: 'ts' }).first()) as { ts?: string | null } | undefined;
      if (!last?.ts) return insufficient(`还没有 ${role} 进程的采样`);
      const ageSec = Math.round((now.getTime() - Date.parse(last.ts)) / 1000);
      return ageSec > rule.windowSec
        ? { name: rule.name, state: 'ALARM', value: ageSec, detail: `${role} 进程已 ${ageSec} 秒没有心跳（窗口 ${fmtWindow(rule.windowSec)}）` }
        : { name: rule.name, state: 'OK', value: ageSec, detail: `${role} 进程 ${ageSec} 秒前有心跳` };
    }
    case 'sum':
    default:
      return insufficient(`没有本地数据源：${rule.metric ?? rule.kind}（例如 log.events 需要 logging 的计数）`);
  }
}

function isRouteCount(m?: string): boolean {
  return m === 'route.count' || m === 'route.count{status=5xx}';
}

function round(v: number): string {
  return Math.abs(v) >= 100 ? String(Math.round(v)) : String(Math.round(v * 1000) / 1000);
}

function fmtWindow(sec: number): string {
  return sec % 60 === 0 ? `${sec / 60} 分钟` : `${sec} 秒`;
}

/** 每个告警最近一次记录的状态（source=local） */
export async function latestLocalStates(db: Knex): Promise<Map<string, { state: AlarmState; ts: string; detail: string | null; value: number | null }>> {
  const rows = (await db('alert_events').where('source', 'local').orderBy([{ column: 'alarm' }, { column: 'id', order: 'desc' }])
    .select('alarm', 'state', 'ts', 'detail', 'value')) as Array<{ alarm: string; state: AlarmState; ts: string; detail: string | null; value: number | null }>;
  const out = new Map<string, { state: AlarmState; ts: string; detail: string | null; value: number | null }>();
  for (const r of rows) if (!out.has(r.alarm)) out.set(r.alarm, { state: r.state, ts: r.ts, detail: r.detail, value: r.value === null ? null : Number(r.value) });
  return out;
}

export async function readEvaluatorHeartbeat(db: Knex): Promise<EvaluatorHeartbeat | null> {
  try {
    const v = await getMeta(db, EVALUATOR_META_KEY);
    return v ? (JSON.parse(v) as EvaluatorHeartbeat) : null;
  } catch {
    return null;
  }
}

export class AlertEvaluator {
  private readonly loader: AlertRulesLoader;
  private readonly holder = `${os.hostname()}:${process.pid}`;
  private states?: Map<string, AlarmState>;

  constructor(private readonly deps: AlertEvaluatorDeps) {
    this.loader = new AlertRulesLoader(alertsFile(deps.envDir));
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  rules(): AlertRulesFile {
    return this.deps.rules?.() ?? this.loader.load();
  }

  /** 一轮评估：判定全部规则，状态变化时写 alert_events 并通知。返回每条规则的结果与是否有变化。 */
  async evaluateOnce(): Promise<Array<RuleResult & { changed: boolean; from?: AlarmState }>> {
    const { db } = this.deps;
    const file = this.rules();
    const now = this.now();
    if (!this.states) {
      this.states = new Map([...(await latestLocalStates(db)).entries()].map(([k, v]) => [k, v.state]));
    }
    const out: Array<RuleResult & { changed: boolean; from?: AlarmState }> = [];
    for (const rule of file.rules) {
      let r: RuleResult;
      try {
        r = await evaluateRule(db, rule, now);
      } catch (e) {
        r = { name: rule.name, state: 'INSUFFICIENT_DATA', value: null, detail: `评估失败：${(e as Error).message}` };
      }
      const prev = this.states.get(rule.name);
      const changed = prev !== r.state;
      if (changed) {
        await db('alert_events').insert({ ts: now.toISOString(), alarm: rule.name, state: r.state, value: r.value, detail: r.detail, source: 'local' });
        this.states.set(rule.name, r.state);
        // 进入 ALARM，或从 ALARM 恢复：通知（首次评估得到的 OK / INSUFFICIENT_DATA 不通知）
        if (r.state === 'ALARM' || prev === 'ALARM') await this.notify(file, r, prev).catch((e: unknown) => this.deps.logger?.warn('monitoring.alert.notify failed', { alarm: r.name, error: (e as Error).message }));
        this.deps.logger?.info('monitoring.alert.transition', { alarm: r.name, from: prev ?? null, to: r.state, value: r.value, source: 'local' });
      }
      out.push({ ...r, changed, ...(prev ? { from: prev } : {}) });
    }
    const hb: EvaluatorHeartbeat = { at: now.toISOString(), holder: this.holder, rules: file.rules.length, intervalSec: file.evaluateEverySec, source: file.source };
    await setMeta(db, EVALUATOR_META_KEY, JSON.stringify(hb)).catch(() => undefined);
    return out;
  }

  private async notify(file: AlertRulesFile, r: RuleResult, prev: AlarmState | undefined): Promise<void> {
    const { db } = this.deps;
    const title = r.state === 'ALARM' ? `【本地告警】${r.name} 进入 ALARM` : `【本地告警】${r.name} 已恢复（${prev ?? '?'} → ${r.state}）`;
    const body = `${r.detail}\n送达路径：本地评估器（worker 进程内；实例宕机即失效）。`;
    const eventKey = `alarm:${r.name}:${r.state}:${this.now().toISOString()}`;
    const admins = await listAdmins(db);
    for (const a of admins) {
      await insertNotification(db, {
        eventId: `ma:${createHash('sha256').update(`${eventKey}|${a.id}`).digest('hex').slice(0, 40)}`, userId: a.id, type: 'monitoring.alarm', title, body,
        link: '/lab/m/monitoring', data: { alarm: r.name, state: r.state, source: 'local' },
      });
    }
    const email = this.deps.email;
    if (!email) return;
    const to = file.alertEmail ? [file.alertEmail] : admins.map((a) => a.email).filter(Boolean);
    if (!to.length) return;
    await email.send({
      to, subject: title, category: 'system',
      text: `${body}\n\n${this.deps.appBaseUrl ? `${this.deps.appBaseUrl.replace(/\/$/, '')}/lab/m/monitoring\n` : ''}（此邮件由 CloudAlbum 本地告警评估器发出）`,
      tags: { module: 'monitoring', alarm: r.name },
    });
  }

  /**
   * worker 内循环：每 evaluateEverySec 秒取一次单例锁并评估；拿不到锁时跳过（别的实例在评估）。
   * 返回停止函数；signal 终止时自动停止。
   */
  start(signal?: AbortSignal): () => void {
    let stopped = false;
    let timer: NodeJS.Timeout | undefined;
    const tick = async () => {
      if (stopped) return;
      const every = this.rules().evaluateEverySec;
      try {
        const lease = this.deps.lock ? await this.deps.lock.tryAcquire(EVALUATOR_LOCK, every * 2) : { release: async () => undefined };
        if (lease) {
          try {
            await this.evaluateOnce();
          } finally {
            await lease.release().catch(() => undefined);
          }
        }
      } catch (e) {
        this.deps.logger?.warn('monitoring.alert.evaluate failed', { error: (e as Error).message });
      }
      if (!stopped) {
        timer = setTimeout(() => void tick(), every * 1000);
        timer.unref?.();
      }
    };
    // 第一轮在一个评估周期之后：进程刚启动时别的进程（api）的采样还没落库，立即评估会把“刚恢复”误判为心跳缺失
    timer = setTimeout(() => void tick(), (this.deps.firstDelayMs ?? this.rules().evaluateEverySec * 1000));
    timer.unref?.();
    const stop = () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
    signal?.addEventListener('abort', stop, { once: true });
    return stop;
  }
}

/** worker 装配用（集成阶段在 worker.ts 中调用）：本地告警评估器始终开启，与 METRICS_DRIVER 无关 */
export function startAlertEvaluator(c: {
  db: Knex; lock: LockPort; email: EmailPort; logger: Logger; config: { core: { CLOUDALBUM_ENV_DIR: string; APP_BASE_URL: string } };
}, signal: AbortSignal): AlertEvaluator {
  const ev = new AlertEvaluator({
    db: c.db, envDir: c.config.core.CLOUDALBUM_ENV_DIR, lock: c.lock, email: c.email, logger: c.logger, appBaseUrl: c.config.core.APP_BASE_URL,
  });
  ev.start(signal);
  return ev;
}
