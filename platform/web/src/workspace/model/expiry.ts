/**
 * 倒计时、T-15 / T-5 提醒、到期覆盖层、延长与结束的判定（08 P05.9；02 §5.4、§5.5、§8）。纯函数。
 *
 * - 剩余时间只由 `deadlineAt − serverNow` 计算（不做递减）；浏览器到 0 时不调用“结束”，只加快轮询（§7.6 第 1 条）；
 * - T-15 横幅：会话进入 EXPIRING，或本地计算剩余 ≤ 15 分钟先到；T-5 模态只出现一次、只对学员；
 * - 离开可延长的状态（U4，或会话进入 ENDING 及以后）：自动关闭仍打开的到期提醒、延长、结束对话框（不论何时打开）；
 * - 截止时间后 2 分钟仍未进入 ENDING：覆盖层追加“平台正在补触发到期处理”（P13 Scheduler 漂移）。
 */
import type { SessionState } from '@atl/shared';
import type { AllowedAction, SessionView } from '../../api/types';

const MIN = 60_000;
export const T15_MS = 15 * MIN;
export const T5_MS = 5 * MIN;
export const LAST_EXTEND_WINDOW_MS = 30_000;
export const SCHEDULER_DRIFT_MS = 2 * MIN;

const LIVE: readonly SessionState[] = ['READY', 'RUNNING', 'EXPIRING'];

export function remainingMs(view: Pick<SessionView, 'deadlineAt'> | null, nowMs: number): number | null {
  if (!view?.deadlineAt) return null;
  const d = Date.parse(view.deadlineAt);
  return Number.isFinite(d) ? d - nowMs : null;
}

export type ExpiryPhase = 'none' | 't15' | 't5' | 'last-minute' | 'overdue' | 'over';

/** 当前提醒阶段（工作台内）。 */
export function expiryPhase(view: Pick<SessionView, 'state' | 'deadlineAt'> | null, nowMs: number): ExpiryPhase {
  if (!view) return 'none';
  if (!LIVE.includes(view.state)) return ['ENDING', 'CLEANING', 'ENDED', 'KEPT', 'CLEANUP_FAILED', 'FAILED'].includes(view.state) ? 'over' : 'none';
  const r = remainingMs(view, nowMs);
  if (r === null) return 'none';
  if (r <= 0) return 'overdue';
  if (r <= MIN) return 'last-minute';
  if (r <= T5_MS) return 't5';
  if (r <= T15_MS || view.state === 'EXPIRING') return 't15';
  return 'none';
}

/** 横幅：EXPIRING 或剩余 ≤ 15 分钟（覆盖层出现后不再显示）。 */
export function showT15Banner(phase: ExpiryPhase): boolean {
  return phase === 't15' || phase === 't5' || phase === 'last-minute';
}

/** 到期覆盖层：本地已到截止时间，或会话进入 ENDING / CLEANING（只读 + 覆盖层，§2.4 表 2）。 */
export function showExpiredOverlay(view: Pick<SessionView, 'state' | 'deadlineAt'> | null, nowMs: number): 'overdue' | 'revoking' | null {
  if (!view) return null;
  if (view.state === 'ENDING' || view.state === 'CLEANING') return 'revoking';
  return expiryPhase(view, nowMs) === 'overdue' ? 'overdue' : null;
}

/** 截止时间后 2 分钟仍未进入 ENDING。 */
export function schedulerDrift(view: Pick<SessionView, 'state' | 'deadlineAt'> | null, nowMs: number): boolean {
  const r = remainingMs(view, nowMs);
  return !!view && LIVE.includes(view.state) && r !== null && r <= -SCHEDULER_DRIFT_MS;
}

/** 会话仍处于“可延长 / 可结束”的状态（否则自动关闭相关对话框）。 */
export function actionableState(view: Pick<SessionView, 'state' | 'deadlineAt'> | null, nowMs: number): boolean {
  if (!view || !LIVE.includes(view.state)) return false;
  const r = remainingMs(view, nowMs);
  return r === null || r > 0;
}

/** T-5 模态是否该弹出：只对学员、只一次（按 deadlineVersion 去重），剩余 ≤ 5 分钟且 > 0。 */
export function shouldOpenT5(view: Pick<SessionView, 'state' | 'deadlineAt' | 'deadlineVersion'> | null, nowMs: number, learner: boolean, shownFor: ReadonlySet<string>): boolean {
  if (!learner || !view) return false;
  const p = expiryPhase(view, nowMs);
  if (p !== 't5' && p !== 'last-minute') return false;
  return !shownFor.has(t5Key(view));
}

export function t5Key(view: Pick<SessionView, 'deadlineAt' | 'deadlineVersion'>): string {
  return `${view.deadlineVersion ?? 0}:${view.deadlineAt ?? ''}`;
}

export type ExtendReason = 'state' | 'none' | 'last30s' | 'cap' | 'uninstalling' | 'budget' | 'role';

export const EXTEND_REASON_TEXT: Readonly<Record<ExtendReason, string>> = {
  state: '实验已到期或正在结束，无法延长。',
  none: '已延长到上限次数。',
  last30s: '即将到期，无法延长。',
  cap: '已达到单次实验总时长上限。',
  uninstalling: '平台正在卸载，不能延长。',
  budget: '本月费用已超过预算，不能延长。',
  role: '你的角色不能延长实验。',
};

export interface GuardContext {
  learner: boolean;
  uninstalling: boolean;
  budgetExceeded: boolean;
  nowMs: number;
}

/** “延长”不可用的原因（打开前与提交前都检查：allowedActions 含 extend 且剩余 > 30 秒，P05.9 防御性检查）。 */
export function extendBlock(view: SessionView, allowed: readonly AllowedAction[], ctx: GuardContext): ExtendReason | null {
  if (!ctx.learner) return 'role';
  if (!LIVE.includes(view.state)) return 'state';
  const r = remainingMs(view, ctx.nowMs);
  if (r !== null && r <= LAST_EXTEND_WINDOW_MS) return r <= 0 ? 'state' : 'last30s';
  if (allowed.includes('extend')) return null;
  if ((view.limits?.extensionsLeft ?? 0) <= 0) return 'none';
  if ((view.limits?.extensionMinutesLeft ?? 1) <= 0) return 'cap';
  if (view.limits?.maxDeadlineAt && view.deadlineAt && Date.parse(view.deadlineAt) >= Date.parse(view.limits.maxDeadlineAt)) return 'cap';
  if (ctx.uninstalling) return 'uninstalling';
  if (ctx.budgetExceeded) return 'budget';
  return 'state';
}

export type KeepReason = 'not-allowed' | 'degraded' | 'uninstalling' | 'budget' | 'env-age' | 'state';

export const KEEP_REASON_TEXT: Readonly<Record<KeepReason, string>> = {
  'not-allowed': '本卡片不允许保留环境，只能释放。',
  degraded: '环境异常时不能保留，只能释放。',
  uninstalling: '平台正在卸载，进行中的实验会被结束，不允许保留。',
  budget: '本月费用已超过预算，只能释放。',
  'env-age': '环境已超过最长寿命，只能释放。',
  state: '当前状态不能保留环境。',
};

export interface KeepContext extends GuardContext {
  envDegraded: boolean;
  /** 卡片 `retain.allowed`。 */
  cardAllows: boolean;
}

/** “保留环境”置灰的原因（P05.9 EndDialog）。 */
export function keepBlock(view: SessionView & { env?: (SessionView['env'] & { maxAgeUntil?: string | null }) | null }, allowed: readonly AllowedAction[], ctx: KeepContext): KeepReason | null {
  if (!ctx.cardAllows || view.limits?.keepAllowed === false) return 'not-allowed';
  if (ctx.envDegraded) return 'degraded';
  if (ctx.uninstalling) return 'uninstalling';
  if (ctx.budgetExceeded) return 'budget';
  const maxAge = view.env?.maxAgeUntil ? Date.parse(view.env.maxAgeUntil) : null;
  if (maxAge !== null && Number.isFinite(maxAge) && maxAge <= ctx.nowMs) return 'env-age';
  if (!allowed.includes('end-keep')) return 'state';
  return null;
}

/** 保留时长选项：1、4、12、24 小时，上限 = min(MaxKeepHours, 卡片 retain.maxHours)。 */
export function keepHourOptions(maxHours: number | null | undefined): number[] {
  const cap = maxHours && maxHours > 0 ? maxHours : 24;
  const opts = [1, 4, 12, 24].filter((h) => h <= cap);
  if (!opts.length || opts[opts.length - 1]! < cap) opts.push(cap);
  return [...new Set(opts)].sort((a, b) => a - b);
}

export type Disposition = 'destroy' | 'keep';
export type When = 'now' | 'at-expiry';

/** 主按钮文案随选择变化（P05.9）。 */
export function endPrimaryLabel(disposition: Disposition, when: When, keepHours: number): string {
  if (when === 'now') return disposition === 'keep' ? `结束并保留环境 ${keepHours} 小时` : '结束并释放资源';
  return disposition === 'keep' ? `到期时保留 ${keepHours} 小时` : '到期时释放';
}

/** 延长对话框的说明文字：“延长后 17:00 到期（第 1 次，还可以再延长 1 次；本次实验最晚到 17:30）”。 */
export function extendSummary(view: SessionView, minutes: number, fmt: (ms: number) => string): string {
  const deadline = view.deadlineAt ? Date.parse(view.deadlineAt) : null;
  const left = view.limits?.extensionsLeft ?? 0;
  const used = Array.isArray(view.extensions) ? view.extensions.length : 0;
  const after = deadline !== null ? fmt(deadline + minutes * MIN) : '—';
  const nth = `第 ${used + 1} 次`;
  // 之后还能延长几次：受剩余次数与“最晚到”两方面约束
  const maxDl = view.limits?.maxDeadlineAt ? Date.parse(view.limits.maxDeadlineAt) : null;
  const byCap = maxDl !== null && deadline !== null ? Math.max(0, Math.floor((maxDl - (deadline + minutes * MIN)) / (minutes * MIN))) : Number.POSITIVE_INFINITY;
  const rest = Math.min(left - 1, byCap);
  const more = rest <= 0 ? '这是最后一次延长' : `还可以再延长 ${rest} 次`;
  const latest = view.limits?.maxDeadlineAt ? `；本次实验最晚到 ${fmt(Date.parse(view.limits.maxDeadlineAt))}` : '';
  return `延长后 ${after} 到期（${nth}，${more}${latest}）。`;
}

/** 报价剩余有效期（毫秒；没有 expiresAt 时 null）。 */
export function quoteRemainingMs(quote: { expiresAt?: string | null } | null, nowMs: number): number | null {
  if (!quote?.expiresAt) return null;
  const t = Date.parse(quote.expiresAt);
  return Number.isFinite(t) ? t - nowMs : null;
}
