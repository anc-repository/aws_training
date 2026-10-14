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

import { msg, withText } from '../i18n/core';

const T = msg.ui.semantics;
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

export const SESSION_STATE_META: Readonly<Record<DisplaySessionState, SessionStateMeta>> = withText(
  {
    REQUESTED: { shape: 'clock', tone: 'pend', pill: 'p-req', spill: 'u-prep' },
    PROVISIONING: { shape: 'clock', tone: 'pend', pill: 'p-prep', spill: 'u-prep', spin: true },
    READY: { shape: 'dot', tone: 'live', pill: 'p-live', spill: 'u-live' },
    RUNNING: { shape: 'dot', tone: 'live', pill: 'p-live', spill: 'u-live' },
    EXPIRING: { shape: 'tri', tone: 'drift', pill: 'p-warn', spill: 'u1' },
    OVERDUE: { shape: 'hg', tone: 'mut', pill: 'p-wind', spill: 'u4' },
    ENDING: { shape: 'hg', tone: 'mut', pill: 'p-wind', spill: 'u-wind' },
    CLEANING: { shape: 'hg', tone: 'mut', pill: 'p-wind', spill: 'u-wind' },
    KEPT: { shape: 'dia', tone: 'kept', pill: 'p-kept', spill: 'u-kept' },
    ENDED: { shape: 'sq', tone: 'mut', pill: 'p-ended', spill: 'u-wind' },
    FAILED: { shape: 'xbox', tone: 'fail', pill: 'p-fail', spill: 'u-fail' },
    CLEANUP_FAILED: { shape: 'tri', tone: 'fail', pill: 'p-cf', spill: 'u-fail' },
  },
  T.sessionState,
);

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

const urgency = (shape: ShapeName, cls: UrgencyMeta['cls'], key: 'U1' | 'U2' | 'U3' | 'U4' | null): UrgencyMeta => ({
  shape,
  cls,
  get announce() {
    return key ? T.urgencyAnnounce[key] : null;
  },
});

export const URGENCY_META: Readonly<Record<Urgency, UrgencyMeta>> = {
  U0: urgency('clock', 'u0', null),
  U1: urgency('tri', 'u1', 'U1'),
  U2: urgency('sq', 'u2', 'U2'),
  U3: urgency('sq', 'u3', 'U3'),
  U4: urgency('hg', 'u4', 'U4'),
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

export const CHECK_RESULT_META: Readonly<Record<CheckResult, StatusMeta>> = withText(
  {
    not_run: { shape: 'ring', tone: 'faint' },
    queued: { shape: 'clock', tone: 'pend' },
    running: { shape: 'spin', tone: 'pend', spin: true },
    pass: { shape: 'check', tone: 'pass' },
    fail: { shape: 'xbox', tone: 'fail' },
    pending: { shape: 'clock', tone: 'pend' },
    error: { shape: 'wrench', tone: 'err' },
    unavailable: { shape: 'q', tone: 'needs' },
    skipped: { shape: 'dash', tone: 'mut' },
    needs_manual: { shape: 'q', tone: 'needs' },
    manual: { shape: 'man', tone: 'manual' },
    manual_evidence: { shape: 'manp', tone: 'manual' },
  },
  T.checkResult,
);

/** 带原因码的特例：`pending/OWNERSHIP_PENDING`、`unavailable/EXPECTED_OUTAGE`；`error/CHANNEL_DOWN` 与预期中断同一文案（§9.2 #20）。 */
export function checkResultMeta(result: CheckResult, reason?: string | null): StatusMeta {
  if (result === 'pending' && reason === 'OWNERSHIP_PENDING') return { text: T.checkResultSpecial.ownershipPending, shape: 'clock', tone: 'pend' };
  if (result === 'unavailable' && reason === 'EXPECTED_OUTAGE') return { text: T.checkResultSpecial.expectedOutage, shape: 'hg', tone: 'mut' };
  return CHECK_RESULT_META[result];
}

// ---------------------------------------------------------------------------------------------------------------
// 判定来源（08 §5.3 SourceTag；删除 ui-design 的 client 来源，04 D-5）

export const SOURCE_META: Readonly<Record<CheckSource, { symbol: string; text: string }>> = withText(
  {
    LOCAL: { symbol: '◇' },
    PROBE: { symbol: '○' },
    AWS: { symbol: '□' },
    EXP: { symbol: '△' },
    MANUAL: { symbol: '⬚' },
  },
  T.source,
);

export type ManualSub = 'native' | 'degraded' | 'evidence';
export const MANUAL_SUB_TEXT: Readonly<Record<ManualSub, string>> = T.manualSub;

// ---------------------------------------------------------------------------------------------------------------
// 步骤（04 §8.3）与尝试（04 §8.4）

export type StepState = 'locked' | 'available' | 'verifying' | 'failed' | 'error' | 'needs_manual' | 'done' | 'done_manual' | 'drifted' | 'skipped';

export const STEP_STATE_META: Readonly<Record<StepState, StatusMeta>> = withText(
  {
    locked: { shape: 'lock', tone: 'lock' },
    available: { shape: 'ring', tone: 'mut' },
    verifying: { shape: 'clock', tone: 'pend' },
    failed: { shape: 'xbox', tone: 'fail' },
    error: { shape: 'wrench', tone: 'err' },
    needs_manual: { shape: 'q', tone: 'needs' },
    done: { shape: 'check', tone: 'pass' },
    done_manual: { shape: 'man', tone: 'manual' },
    drifted: { shape: 'tri', tone: 'drift' },
    skipped: { shape: 'dash', tone: 'mut' },
  },
  T.stepState,
);

export type AttemptStatus = 'active' | 'verifying' | 'completed' | 'completed_manual' | 'incomplete' | 'unverified' | 'void';

export const ATTEMPT_STATUS_META: Readonly<Record<AttemptStatus, StatusMeta>> = withText(
  {
    active: { shape: 'clock', tone: 'pend' },
    verifying: { shape: 'clock', tone: 'pend' },
    completed: { shape: 'check', tone: 'pass' },
    completed_manual: { shape: 'man', tone: 'manual' },
    incomplete: { shape: 'half', tone: 'mut' },
    unverified: { shape: 'q', tone: 'needs' },
    void: { shape: 'dash', tone: 'faint' },
  },
  T.attemptStatus,
);

// ---------------------------------------------------------------------------------------------------------------
// 资源清理（01 §7.3）、严重级别、计费方式

export const CLEANUP_STATE_META: Readonly<Record<CleanupState, StatusMeta>> = withText(
  {
    TRACKED: { shape: 'ring', tone: 'mut' },
    DELETING: { shape: 'clock', tone: 'pend' },
    DELETED: { shape: 'check', tone: 'pass' },
    RETAINED: { shape: 'dia', tone: 'kept' },
    REVIEW: { shape: 'tri', tone: 'drift' },
    MANUAL_REQUIRED: { shape: 'sq', tone: 'fail' },
    RESOLVED_BY_LEARNER: { shape: 'check', tone: 'pass' },
    FAILED: { shape: 'xbox', tone: 'fail' },
  },
  T.cleanupState,
);

export const SEVERITY_META: Readonly<Record<ResourceSeverity, StatusMeta>> = withText(
  {
    BLOCKING: { shape: 'sq', tone: 'fail' },
    REVIEW: { shape: 'tri', tone: 'drift' },
    INFO: { shape: 'dot', tone: 'mut' },
  },
  T.severity,
);

export const BILLING_TEXT: Readonly<Record<ResourceBilling, string>> = T.billing;

// ---------------------------------------------------------------------------------------------------------------
// 实验有效性、预算、费用档位

export type ExperimentValidity = 'valid' | 'simulated' | 'pending-crosscheck' | 'invalid';

export const VALIDITY_META: Readonly<Record<ExperimentValidity, StatusMeta>> = withText(
  {
    valid: { shape: 'dot', tone: 'pass' },
    simulated: { shape: 'half', tone: 'stale' },
    'pending-crosscheck': { shape: 'clock', tone: 'pend' },
    invalid: { shape: 'xbox', tone: 'fail' },
  },
  T.validity,
);

export const BUDGET_META: Readonly<Record<BudgetState, StatusMeta>> = withText(
  {
    OK: { shape: 'dot', tone: 'pass' },
    WARN: { shape: 'tri', tone: 'drift' },
    EXCEEDED: { shape: 'sq', tone: 'fail' },
  },
  T.budget,
);

export type CostTier = 'low' | 'medium' | 'high';

/** 费用档位只用等宽 `$` 数量 + 文字，颜色统一 --text-2，不用红绿（08 §6.6、05 §2.8）。 */
export const COST_TIER_META: Readonly<Record<CostTier, { symbol: string; text: string }>> = withText(
  {
    low: { symbol: '$' },
    medium: { symbol: '$$' },
    high: { symbol: '$$$' },
  },
  T.costTier,
);
