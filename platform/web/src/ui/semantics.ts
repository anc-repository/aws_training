/**
 * 全站唯一的状态映射（08 §6.2：“下面三张表是全站唯一的映射，组件不得自行选色”）。
 * 每个状态同时给出 文字 + 形状 + 色调（色调是 components.css 中 `.st.<tone>` / `.pill.<cls>` 的类名），
 * 灰度截图中仍能区分。文字取 02 §2.1“学员看到”列、04 §5.3 / §8.3 / §8.4、01 §7.3（08 §6.3～§6.6）。
 */
import type {
  BudgetState,
  CheckSource,
  CleanupState,
  ResourceBilling,
  ResourceSeverity,
  SessionState,
} from '@atl/shared';
import type { ShapeName } from './Shape';

/** `.st.<tone>` 文字色调（components.css）。 */
export type Tone = 'pass' | 'fail' | 'pend' | 'drift' | 'manual' | 'needs' | 'err' | 'stale' | 'lock' | 'mut' | 'faint' | 'live' | 'kept';

export interface StatusMeta {
  text: string;
  shape: ShapeName;
  tone: Tone;
  /** 形状是否转圈（减少动效时静止，08 §6.10）。 */
  spin?: boolean;
}

// ---------------------------------------------------------------------------------------------------------------
// 会话状态（08 §6.3）

/** 会话状态 + 过渡态 `OVERDUE`（已到截止时间、服务端尚未进入 ENDING，§6.3 “已到期 · 正在结束”）。 */
export type DisplaySessionState = SessionState | 'OVERDUE';

export interface SessionStateMeta extends StatusMeta {
  /** `SessionStatePill` 的胶囊类名（`.pill.<cls>`）。 */
  pill: 'p-req' | 'p-prep' | 'p-live' | 'p-warn' | 'p-wind' | 'p-kept' | 'p-ended' | 'p-fail' | 'p-cf';
  /** 顶栏 `SessionPill` 的底色类名（`.spill.<cls>`）。 */
  spill: 'u-prep' | 'u-live' | 'u1' | 'u2' | 'u4' | 'u-wind' | 'u-kept' | 'u-fail';
}

export const SESSION_STATE_META: Readonly<Record<DisplaySessionState, SessionStateMeta>> = {
  REQUESTED: { text: '正在校验', shape: 'clock', tone: 'pend', pill: 'p-req', spill: 'u-prep' },
  PROVISIONING: { text: '正在准备环境', shape: 'clock', tone: 'pend', pill: 'p-prep', spill: 'u-prep', spin: true },
  READY: { text: '环境已就绪', shape: 'dot', tone: 'live', pill: 'p-live', spill: 'u-live' },
  RUNNING: { text: '实验中', shape: 'dot', tone: 'live', pill: 'p-live', spill: 'u-live' },
  EXPIRING: { text: '即将到期', shape: 'tri', tone: 'drift', pill: 'p-warn', spill: 'u1' },
  OVERDUE: { text: '已到期 · 正在结束', shape: 'hg', tone: 'mut', pill: 'p-wind', spill: 'u4' },
  ENDING: { text: '正在结束', shape: 'hg', tone: 'mut', pill: 'p-wind', spill: 'u-wind' },
  CLEANING: { text: '正在释放资源', shape: 'hg', tone: 'mut', pill: 'p-wind', spill: 'u-wind' },
  KEPT: { text: '环境保留中', shape: 'dia', tone: 'kept', pill: 'p-kept', spill: 'u-kept' },
  ENDED: { text: '已结束', shape: 'sq', tone: 'mut', pill: 'p-ended', spill: 'u-wind' },
  FAILED: { text: '启动失败', shape: 'xbox', tone: 'fail', pill: 'p-fail', spill: 'u-fail' },
  CLEANUP_FAILED: { text: '释放未完成', shape: 'tri', tone: 'fail', pill: 'p-cf', spill: 'u-fail' },
};

export const COUNTDOWN_STATES: readonly SessionState[] = ['READY', 'RUNNING', 'EXPIRING'];
export const PREPARING_STATES: readonly SessionState[] = ['REQUESTED', 'PROVISIONING'];
export const WINDING_STATES: readonly SessionState[] = ['ENDING', 'CLEANING'];

/** 本地已到截止时间而服务端仍在 READY / RUNNING / EXPIRING 时显示过渡态（08 §6.3、P13 #18）。 */
export function displayState(state: SessionState, remainingMs: number | null): DisplaySessionState {
  if (COUNTDOWN_STATES.includes(state) && remainingMs !== null && remainingMs <= 0) return 'OVERDUE';
  return state;
}

// ---------------------------------------------------------------------------------------------------------------
// 倒计时紧急程度（08 §6.4）

export type Urgency = 'U0' | 'U1' | 'U2' | 'U3' | 'U4';

const MIN = 60_000;

/** U0 > 15 分钟；U1 ≤ 15 分钟；U2 ≤ 5 分钟；U3 ≤ 60 秒；U4 ≤ 0（按服务端时间）。 */
export function urgencyOf(remainingMs: number): Urgency {
  if (remainingMs <= 0) return 'U4';
  if (remainingMs <= 60_000) return 'U3';
  if (remainingMs <= 5 * MIN) return 'U2';
  if (remainingMs <= 15 * MIN) return 'U1';
  return 'U0';
}

export interface UrgencyMeta {
  shape: ShapeName;
  /** `.cdbig.<cls>`（工作台顶栏）与顶栏胶囊的升级类名。 */
  cls: 'u0' | 'u1' | 'u2' | 'u3' | 'u4';
  /** 到达该等级时 `LiveRegion` 播报一次（15、5、1 分钟与 0，§8.4）。 */
  announce: string | null;
}

export const URGENCY_META: Readonly<Record<Urgency, UrgencyMeta>> = {
  U0: { shape: 'clock', cls: 'u0', announce: null },
  U1: { shape: 'tri', cls: 'u1', announce: '实验剩余 15 分钟' },
  U2: { shape: 'sq', cls: 'u2', announce: '实验剩余 5 分钟' },
  U3: { shape: 'sq', cls: 'u3', announce: '实验剩余 1 分钟' },
  U4: { shape: 'hg', cls: 'u4', announce: '实验时间已到，正在结束' },
};

/** 保留环境的提醒等级（§6.4 K1 / K2）：K0 > 60 分钟、K1 ≤ 60 分钟、K2 ≤ 15 分钟。 */
export type KeepUrgency = 'K0' | 'K1' | 'K2';
export function keepUrgencyOf(remainingMs: number): KeepUrgency {
  if (remainingMs <= 15 * MIN) return 'K2';
  if (remainingMs <= 60 * MIN) return 'K1';
  return 'K0';
}

// ---------------------------------------------------------------------------------------------------------------
// 检查结果（04 §5.3 → 08 §6.5）。`running`、`queued` 是界面中的瞬时状态（§5.3 CheckResultRow）。

export type CheckResult =
  | 'not_run'
  | 'queued'
  | 'running'
  | 'pass'
  | 'fail'
  | 'pending'
  | 'error'
  | 'unavailable'
  | 'skipped'
  | 'needs_manual'
  | 'manual'
  | 'manual_evidence';

export const CHECK_RESULT_META: Readonly<Record<CheckResult, StatusMeta>> = {
  not_run: { text: '未检测', shape: 'ring', tone: 'faint' },
  queued: { text: '排队中', shape: 'clock', tone: 'pend' },
  running: { text: '核验中', shape: 'spin', tone: 'pend', spin: true },
  pass: { text: '通过', shape: 'check', tone: 'pass' },
  fail: { text: '未通过', shape: 'xbox', tone: 'fail' },
  pending: { text: '等待中', shape: 'clock', tone: 'pend' },
  error: { text: '检测器出错', shape: 'wrench', tone: 'err' },
  unavailable: { text: '无法检测', shape: 'q', tone: 'needs' },
  skipped: { text: '不适用', shape: 'dash', tone: 'mut' },
  needs_manual: { text: '待手动确认', shape: 'q', tone: 'needs' },
  manual: { text: '已手动确认', shape: 'man', tone: 'manual' },
  manual_evidence: { text: '已手动确认（带证据）', shape: 'manp', tone: 'manual' },
};

/** 带原因码的特例：`pending/OWNERSHIP_PENDING`、`unavailable/EXPECTED_OUTAGE`；`error/CHANNEL_DOWN` 与预期中断同一文案（§9.2 #20）。 */
export function checkResultMeta(result: CheckResult, reason?: string | null): StatusMeta {
  if (result === 'pending' && reason === 'OWNERSHIP_PENDING') return { text: '归属确认中', shape: 'clock', tone: 'pend' };
  if (result === 'unavailable' && reason === 'EXPECTED_OUTAGE') return { text: '预期中断', shape: 'hg', tone: 'mut' };
  return CHECK_RESULT_META[result];
}

// ---------------------------------------------------------------------------------------------------------------
// 判定来源（08 §5.3 SourceTag；删除 ui-design 的 client 来源，04 D-5）

export const SOURCE_META: Readonly<Record<CheckSource, { symbol: string; text: string }>> = {
  LOCAL: { symbol: '◇', text: '本地' },
  PROBE: { symbol: '○', text: '探针' },
  AWS: { symbol: '□', text: 'AWS' },
  EXP: { symbol: '△', text: '实验' },
  MANUAL: { symbol: '⬚', text: '手动' },
};

export type ManualSub = 'native' | 'degraded' | 'evidence';
export const MANUAL_SUB_TEXT: Readonly<Record<ManualSub, string>> = { native: '原生', degraded: '降级', evidence: '带证据' };

// ---------------------------------------------------------------------------------------------------------------
// 步骤（04 §8.3）与尝试（04 §8.4）

export type StepState = 'locked' | 'available' | 'verifying' | 'failed' | 'error' | 'needs_manual' | 'done' | 'done_manual' | 'drifted' | 'skipped';

export const STEP_STATE_META: Readonly<Record<StepState, StatusMeta>> = {
  locked: { text: '未解锁', shape: 'lock', tone: 'lock' },
  available: { text: '可开始', shape: 'ring', tone: 'mut' },
  verifying: { text: '核验中', shape: 'clock', tone: 'pend' },
  failed: { text: '未通过', shape: 'xbox', tone: 'fail' },
  error: { text: '检测器出错', shape: 'wrench', tone: 'err' },
  needs_manual: { text: '待手动确认', shape: 'q', tone: 'needs' },
  done: { text: '已达成', shape: 'check', tone: 'pass' },
  done_manual: { text: '已达成（含手动）', shape: 'man', tone: 'manual' },
  drifted: { text: '漂移', shape: 'tri', tone: 'drift' },
  skipped: { text: '已跳过', shape: 'dash', tone: 'mut' },
};

export type AttemptStatus = 'active' | 'verifying' | 'completed' | 'completed_manual' | 'incomplete' | 'unverified' | 'void';

export const ATTEMPT_STATUS_META: Readonly<Record<AttemptStatus, StatusMeta>> = {
  active: { text: '进行中', shape: 'clock', tone: 'pend' },
  verifying: { text: '最终复核中', shape: 'clock', tone: 'pend' },
  completed: { text: '已完成（全自动）', shape: 'check', tone: 'pass' },
  completed_manual: { text: '已完成（含手动）', shape: 'man', tone: 'manual' },
  incomplete: { text: '未完成', shape: 'half', tone: 'mut' },
  unverified: { text: '未能核验', shape: 'q', tone: 'needs' },
  void: { text: '不计入', shape: 'dash', tone: 'faint' },
};

// ---------------------------------------------------------------------------------------------------------------
// 资源清理（01 §7.3）、严重级别、计费方式

export const CLEANUP_STATE_META: Readonly<Record<CleanupState, StatusMeta>> = {
  TRACKED: { text: '跟踪中', shape: 'ring', tone: 'mut' },
  DELETING: { text: '删除中', shape: 'clock', tone: 'pend' },
  DELETED: { text: '已删除', shape: 'check', tone: 'pass' },
  RETAINED: { text: '保留', shape: 'dia', tone: 'kept' },
  REVIEW: { text: '需复核', shape: 'tri', tone: 'drift' },
  MANUAL_REQUIRED: { text: '需人工处理', shape: 'sq', tone: 'fail' },
  RESOLVED_BY_LEARNER: { text: '你已处理', shape: 'check', tone: 'pass' },
  FAILED: { text: '失败', shape: 'xbox', tone: 'fail' },
};

export const SEVERITY_META: Readonly<Record<ResourceSeverity, StatusMeta>> = {
  BLOCKING: { text: '阻塞', shape: 'sq', tone: 'fail' },
  REVIEW: { text: '需复核', shape: 'tri', tone: 'drift' },
  INFO: { text: '信息', shape: 'dot', tone: 'mut' },
};

export const BILLING_TEXT: Readonly<Record<ResourceBilling, string>> = {
  hourly: '按小时',
  storage: '按存储量',
  monthly: '按月',
  usage: '按用量',
  none: '不计费',
};

// ---------------------------------------------------------------------------------------------------------------
// 实验有效性、预算、费用档位

export type ExperimentValidity = 'valid' | 'simulated' | 'pending-crosscheck' | 'invalid';

export const VALIDITY_META: Readonly<Record<ExperimentValidity, StatusMeta>> = {
  valid: { text: '有效', shape: 'dot', tone: 'pass' },
  simulated: { text: '模拟基线', shape: 'half', tone: 'stale' },
  'pending-crosscheck': { text: '交叉校验中', shape: 'clock', tone: 'pend' },
  invalid: { text: '无效', shape: 'xbox', tone: 'fail' },
};

export const BUDGET_META: Readonly<Record<BudgetState, StatusMeta>> = {
  OK: { text: '正常', shape: 'dot', tone: 'pass' },
  WARN: { text: '接近', shape: 'tri', tone: 'drift' },
  EXCEEDED: { text: '超限', shape: 'sq', tone: 'fail' },
};

export type CostTier = 'low' | 'medium' | 'high';

/** 费用档位只用等宽 `$` 数量 + 文字，颜色统一 --text-2，不用红绿（08 §6.6、05 §2.8）。 */
export const COST_TIER_META: Readonly<Record<CostTier, { symbol: string; text: string }>> = {
  low: { symbol: '$', text: '低' },
  medium: { symbol: '$$', text: '中' },
  high: { symbol: '$$$', text: '高' },
};
