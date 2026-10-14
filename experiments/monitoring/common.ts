/**
 * experiments/monitoring/common.ts —— monitoring 场景共用：读取服务端证据（/api/lab/monitoring/*，仅管理员）。
 *
 * 判定一律以服务端记录为准：本地告警评估器写入 alert_events 的状态变化时间、CloudWatch 告警自己的状态变化历史
 * （DescribeAlarmHistory，经应用读取）、LabMetricsStore / CloudWatch 的曲线——而不是客户端看到的响应。
 * 故障期间（合成 5xx、error5xx、停服务）这些请求也可能失败：一律带重试，且不计入客户端统计（record: false）。
 */
import type { ScenarioContext } from '../_lib/scenario.js';
import { sleep } from '../_lib/util.js';

export interface Transition { at: string; from: string; to: string; reason: string }
export interface HistoryResponse { name: string; local?: Transition[]; cloudwatch?: Transition[]; cloudwatchError?: string }
export interface AlarmView { name: string; state: string; since: string | null; source: string; delivery: string; reason?: string }
export interface AlarmsResponse {
  driver: string;
  local: { alarms: AlarmView[]; evaluator: { at: string; holder: string } | null; rulesSource: string };
  cloudwatch: { enabled: boolean; alarms?: AlarmView[]; error?: string; reason?: string; topicArn?: string | null };
}
export interface SeriesPoint { t: number; v: number }

/** GET（管理员），失败（网络、5xx）时重试；返回 JSON 或 undefined */
export async function getJson<T>(ctx: ScenarioContext, path: string, opts: { attempts?: number; delayMs?: number; timeoutMs?: number } = {}): Promise<T | undefined> {
  const attempts = opts.attempts ?? 5;
  for (let i = 0; i < attempts && !ctx.signal.aborted; i += 1) {
    const r = await ctx.client.get(path, { record: false, timeoutMs: opts.timeoutMs ?? 10_000, expect: [200] });
    if (r.status === 200) return r.json<T>();
    if (r.status === 400 || r.status === 404 || r.status === 409) return undefined;
    await sleep(opts.delayMs ?? 1500, ctx.signal);
  }
  return undefined;
}

export async function alarms(ctx: ScenarioContext): Promise<AlarmsResponse | undefined> {
  return getJson<AlarmsResponse>(ctx, '/api/lab/monitoring/alarms');
}

export async function history(ctx: ScenarioContext, name: string, source: 'local' | 'cloudwatch' | 'both', since: Date): Promise<HistoryResponse | undefined> {
  return getJson<HistoryResponse>(ctx, `/api/lab/monitoring/history?name=${encodeURIComponent(name)}&source=${source}&since=${encodeURIComponent(since.toISOString())}&limit=50`);
}

export async function series(ctx: ScenarioContext, q: { name: string; source: 'local' | 'cloudwatch'; stat: string; period: number; since: Date; until?: Date; namespace?: string; instanceId?: string }): Promise<SeriesPoint[] | undefined> {
  const params = new URLSearchParams({ name: q.name, source: q.source, stat: q.stat, period: String(q.period), since: q.since.toISOString() });
  if (q.until) params.set('until', q.until.toISOString());
  if (q.namespace) params.set('namespace', q.namespace);
  if (q.instanceId) params.set('instanceId', q.instanceId);
  const r = await getJson<{ points: SeriesPoint[] }>(ctx, `/api/lab/monitoring/series?${params.toString()}`);
  return r?.points;
}

/** 某个时刻之后第一次进入 to 状态的时间（ISO；没有时 undefined） */
export function firstTransitionTo(list: readonly Transition[] | undefined, to: string, after: Date): string | undefined {
  return [...(list ?? [])].filter((t) => t.to === to && Date.parse(t.at) >= after.getTime() - 1000)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))[0]?.at;
}

/** 时间窗内的状态变化（含两端） */
export function transitionsBetween(list: readonly Transition[] | undefined, from: Date, to: Date): Transition[] {
  return (list ?? []).filter((t) => Date.parse(t.at) >= from.getTime() && Date.parse(t.at) <= to.getTime());
}

export function secondsBetween(a: Date | string, b: Date | string | undefined): number | undefined {
  if (b === undefined) return undefined;
  return Math.round((Date.parse(String(b instanceof Date ? b.toISOString() : b)) - Date.parse(a instanceof Date ? a.toISOString() : a)) / 1000);
}

/** 平台模式（capabilities.app.platform 只在平台模式出现，06 PM-03） */
export function isPlatform(ctx: ScenarioContext): boolean {
  return Boolean((ctx.capabilities.app as { platform?: unknown } | undefined)?.platform);
}

/** 实验机的实例 ID（capabilities.app.instance.id；不在 EC2 上时是主机名） */
export function instanceIdOf(ctx: ScenarioContext): string | undefined {
  const id = ctx.capabilities.app?.instance?.id;
  return id && /^i-[0-9a-f]{8,17}$/.test(id) ? id : undefined;
}

/** 轮询 /api/health/live：返回首次失败（down）与之后首次恢复（up）的时间（客户端观察，只用来划时间窗） */
export async function observeOutage(ctx: ScenarioContext, opts: { pollSec: number; waitDownSec: number; maxDownSec: number }): Promise<{ downAt?: Date; upAt?: Date }> {
  const live = async () => {
    const r = await ctx.client.get('/api/health/live', { record: false, auth: false, timeoutMs: 3000, expect: [200] });
    return r.status === 200;
  };
  const downDeadline = Date.now() + opts.waitDownSec * 1000;
  let downAt: Date | undefined;
  while (!ctx.signal.aborted && Date.now() < downDeadline) {
    if (!(await live())) { downAt = new Date(); break; }
    await sleep(opts.pollSec * 1000, ctx.signal);
  }
  if (!downAt) return {};
  const upDeadline = Date.now() + opts.maxDownSec * 1000;
  while (!ctx.signal.aborted && Date.now() < upDeadline) {
    await sleep(opts.pollSec * 1000, ctx.signal);
    if (await live()) return { downAt, upAt: new Date() };
  }
  return { downAt };
}
