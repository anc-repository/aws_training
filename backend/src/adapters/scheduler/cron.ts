// backend/src/adapters/scheduler/cron.ts —— SchedulerPort 的 `cron` 驱动（本地实现，L0 默认）
//
// worker 进程内用 node-cron 注册任务（时区 SCHEDULER_TIMEZONE，默认 Asia/Tokyo；04#scheduler 第 1 节）。每次触发走统一入口 runJob：
//   1. singleton 任务先 LockPort.tryAcquire(name)（L0 是文件锁，scope=host）；拿不到锁记 skipped-locked；
//   2. 插入 job_runs（(name, scheduled_at) 唯一）；重复的触发记 skipped-duplicate；
//   3. 执行 handler，回写 ok / failed。
// 计划时间取 node-cron 给出的计划时刻（截到整秒）；triggerNow 用当前时间（trigger=manual）。
// SCHEDULER_CATCHUP=report.daily 时，start() 检查上一个计划时刻是否运行过，没有就补跑一次（trigger=manual）。
// 已知局限（对比点）：触发时刻 worker 不在线就漏跑；多实例时只有 cluster 级的锁或共享库的唯一索引能防止重复执行。
import { hostname } from 'node:os';
import cron, { type ScheduledTask } from 'node-cron';
import type { AdapterDeps } from '../types.js';
import { need } from '../types.js';
import type { AdapterMeta, ProbeResult } from '../../ports/common.js';
import type { JobRun, ScheduledJobDef, ScheduledJobName, SchedulerPort } from '../../ports/scheduler.js';
import type { Lease } from '../../ports/lock.js';
import { HttpError, isNotImplemented } from '../../errors.js';
import { markPath } from '../../observability/request-context.js';
import {
  findScheduledRun, finishRun, listScheduledRuns, recordSkippedRun, startScheduledRun, toJobRun,
} from '../../repositories/job-runs.js';

/** singleton 任务的锁 TTL（秒）：取任务的最长预期耗时；锁会在任务结束时主动释放 */
const LOCK_TTL_SEC: Partial<Record<ScheduledJobName, number>> = {
  'report.daily': 1800, 'image.reconcile': 55, 'share.cleanup': 600, 'outbox.retention': 1800,
  'lab.compact': 1800, 'analytics.retention': 1800, 'audit.retention': 1800,
};

function truncateToSecond(d: Date): Date {
  return new Date(Math.floor(d.getTime() / 1000) * 1000);
}

export class CronScheduler implements SchedulerPort {
  readonly meta: AdapterMeta = { module: 'scheduler', driver: 'cron', awsService: null, authoritative: false };
  private readonly defs = new Map<ScheduledJobName, ScheduledJobDef>();
  private readonly tasks: ScheduledTask[] = [];
  /** LockPort 不可用（未实现）时的进程内互斥 */
  private readonly localRunning = new Set<ScheduledJobName>();
  private lockWarned = false;
  private started = false;
  private lastTickAt: string | null = null;

  constructor(protected readonly deps: AdapterDeps) {}

  private get timezone(): string {
    return this.deps.cfg.scheduler.SCHEDULER_TIMEZONE;
  }

  async probe(_opts?: { deep?: boolean }): Promise<ProbeResult> {
    const registered = this.defs.size;
    const where = this.deps.role === 'worker' ? 'worker 进程' : `${this.deps.role} 进程（不调度，worker 负责）`;
    let failing: string[] = [];
    if (this.deps.db) {
      const recent = await listScheduledRuns(this.deps.db, { limit: 200 });
      const latest = new Map<string, string>();
      for (const r of recent) if (!latest.has(r.name) && (r.status === 'ok' || r.status === 'failed')) latest.set(r.name, r.status);
      failing = [...latest.entries()].filter(([, s]) => s === 'failed').map(([n]) => n);
    }
    const detail = `node-cron（${this.timezone}）· ${where} · 已注册 ${registered} 个任务${failing.length ? ` · 最近失败：${failing.join(', ')}` : ''}`;
    return {
      status: failing.length ? 'degraded' : 'ok', detail,
      data: { registered: [...this.defs.keys()], started: this.started, lastTickAt: this.lastTickAt, failing, lockScope: this.deps.lock?.scope ?? null },
    };
  }

  register(defs: ScheduledJobDef[]): void {
    for (const d of defs) {
      if (!cron.validate(d.cron)) throw new Error(`定时任务 ${d.name} 的表达式无效：${d.cron}`);
      this.defs.set(d.name, d);
    }
  }

  registered(): ScheduledJobDef[] {
    return [...this.defs.values()];
  }

  async start(signal: AbortSignal): Promise<void> {
    if (this.started || signal.aborted) return;
    this.started = true;
    for (const def of this.defs.values()) {
      const task = cron.schedule(def.cron, async (ctx) => {
        const scheduledAt = truncateToSecond(ctx.date ?? new Date());
        this.lastTickAt = new Date().toISOString();
        await this.runJob(def, { trigger: 'cron', scheduledAt }).catch((e: unknown) => {
          this.deps.logger?.error('scheduler.run_failed', { job: def.name, error: e as Error });
        });
      }, { timezone: def.timezone || this.timezone, name: def.name, noOverlap: true });
      this.tasks.push(task);
    }
    await this.catchUp();
    const stop = async () => {
      for (const t of this.tasks) await Promise.resolve(t.stop()).catch(() => undefined);
      for (const t of this.tasks) await Promise.resolve(t.destroy()).catch(() => undefined);
      this.tasks.length = 0;
      this.started = false;
    };
    if (signal.aborted) {
      await stop();
      return;
    }
    signal.addEventListener('abort', () => void stop(), { once: true });
  }

  /** SCHEDULER_CATCHUP：上一个计划时刻没有运行记录的任务补跑一次 */
  private async catchUp(): Promise<void> {
    const names = this.deps.cfg.scheduler.SCHEDULER_CATCHUP.split(',').map((s) => s.trim()).filter(Boolean);
    if (!names.length || !this.deps.db) return;
    for (const name of names) {
      const def = this.defs.get(name as ScheduledJobName);
      if (!def) continue;
      const prev = previousOccurrence(def.cron, def.timezone || this.timezone, new Date());
      if (!prev) continue;
      const ran = await findScheduledRun(this.deps.db, def.name, prev.toISOString());
      if (ran) continue;
      this.deps.logger?.info('scheduler.catchup', { job: def.name, scheduledAt: prev.toISOString() });
      await this.runJob(def, { trigger: 'manual', scheduledAt: prev }).catch(() => undefined);
    }
  }

  private async acquire(def: ScheduledJobDef): Promise<{ kind: 'none' } | { kind: 'lease'; lease: Lease } | { kind: 'local' } | { kind: 'busy' }> {
    if (!def.singleton) return { kind: 'none' };
    const lock = this.deps.lock;
    if (lock) {
      try {
        const lease = await lock.tryAcquire(`job-${def.name}`, LOCK_TTL_SEC[def.name] ?? 600);
        return lease ? { kind: 'lease', lease } : { kind: 'busy' };
      } catch (e) {
        if (!isNotImplemented(e)) throw e;
        if (!this.lockWarned) {
          this.lockWarned = true;
          this.deps.logger?.warn('scheduler.lock_unavailable', { detail: 'LockPort 尚未实现，singleton 任务退回进程内互斥（只在本进程内有效）' });
        }
      }
    }
    if (this.localRunning.has(def.name)) return { kind: 'busy' };
    this.localRunning.add(def.name);
    return { kind: 'local' };
  }

  /** 统一入口：锁 → job_runs 幂等键 → handler → 回写状态 */
  async runJob(def: ScheduledJobDef, opts: { trigger: JobRun['trigger']; scheduledAt: Date }): Promise<JobRun> {
    const db = need(this.deps, 'db', 'scheduler(cron)');
    const scheduledAt = opts.scheduledAt.toISOString();
    const host = hostname();
    const lock = await this.acquire(def);
    if (lock.kind === 'busy') {
      return toJobRun(await recordSkippedRun(db, { name: def.name, scheduledAt, trigger: opts.trigger, status: 'skipped-locked', host }));
    }
    try {
      const run = await startScheduledRun(db, { name: def.name, scheduledAt, trigger: opts.trigger, host });
      if (!run) {
        return toJobRun(await recordSkippedRun(db, { name: def.name, scheduledAt, trigger: opts.trigger, status: 'skipped-duplicate', host }));
      }
      try {
        await def.handler({ scheduledAt: opts.scheduledAt, runId: run.runId });
        return toJobRun((await finishRun(db, run.runId, { status: 'ok' }))!);
      } catch (e) {
        this.deps.logger?.error('scheduler.job_failed', { job: def.name, runId: run.runId, error: e as Error });
        return toJobRun((await finishRun(db, run.runId, { status: 'failed', error: (e as Error)?.message ?? String(e) }))!);
      }
    } finally {
      if (lock.kind === 'local') this.localRunning.delete(def.name);
      else if (lock.kind === 'lease') await lock.lease.release().catch(() => undefined);
    }
  }

  async triggerNow(name: ScheduledJobName): Promise<JobRun> {
    const def = this.defs.get(name);
    if (!def) throw new HttpError(404, 'JOB_NOT_REGISTERED', `定时任务 ${name} 未在本进程注册`);
    markPath('scheduler', 'cron:manual');
    return this.runJob(def, { trigger: 'manual', scheduledAt: new Date() });
  }

  async listRuns(limit: number): Promise<JobRun[]> {
    const db = need(this.deps, 'db', 'scheduler(cron)');
    return (await listScheduledRuns(db, { limit })).map(toJobRun);
  }
}

// ---------------------------------------------------------------------------------------------
// cron 表达式的“上一个计划时刻”（补跑用）：在给定时区内逐分钟回溯，最多 8 天
// ---------------------------------------------------------------------------------------------
function zonedFields(d: Date, timeZone: string): { minute: number; hour: number; day: number; month: number; weekday: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false, minute: 'numeric', hour: 'numeric', day: 'numeric', month: 'numeric', weekday: 'short',
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '0';
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  return { minute: Number(get('minute')), hour: Number(get('hour')) % 24, day: Number(get('day')), month: Number(get('month')), weekday: wd };
}

function fieldMatches(spec: string, value: number, min: number, max: number): boolean {
  return spec.split(',').some((part) => {
    const [range, stepStr] = part.split('/');
    const step = stepStr ? Number(stepStr) : 1;
    let lo = min;
    let hi = max;
    if (range && range !== '*') {
      const [a, b] = range.split('-');
      lo = Number(a);
      hi = b !== undefined ? Number(b) : stepStr ? max : lo;
    }
    if (value === 7 && max === 7) value = 0;
    return value >= lo && value <= hi && (value - lo) % step === 0;
  });
}

/** 只支持 5 段（分 时 日 月 周）的数字表达式（jobs/schedule.ts 的全部表达式都满足） */
export function cronMatches(expr: string, d: Date, timeZone: string): boolean {
  const f = expr.trim().split(/\s+/);
  const spec = f.length === 6 ? f.slice(1) : f;
  if (spec.length !== 5) return false;
  const z = zonedFields(d, timeZone);
  const [mi, h, dom, mon, dow] = spec as [string, string, string, string, string];
  const domOk = fieldMatches(dom, z.day, 1, 31);
  const dowOk = fieldMatches(dow, z.weekday, 0, 7);
  const dayOk = dom === '*' || dow === '*' ? domOk && dowOk : domOk || dowOk;
  return fieldMatches(mi, z.minute, 0, 59) && fieldMatches(h, z.hour, 0, 23) && fieldMatches(mon, z.month, 1, 12) && dayOk;
}

export function previousOccurrence(expr: string, timeZone: string, before: Date): Date | null {
  const start = Math.floor(before.getTime() / 60_000) * 60_000;
  for (let i = 0; i <= 8 * 24 * 60; i++) {
    const t = new Date(start - i * 60_000);
    if (t.getTime() > before.getTime()) continue;
    if (cronMatches(expr, t, timeZone)) return t;
  }
  return null;
}
