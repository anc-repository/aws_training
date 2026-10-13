/**
 * 会话状态 → 画面（08 §2.4 表 2）与顶栏胶囊去向（§3.3），以及 allowedActions 的回写前推导（§3.3、§9.2 #27）。
 * 纯函数，表驱动测试见 sessionRouting.test.ts。
 */
import type { SessionState } from '@atl/shared';
import type { AllowedAction, SessionView } from '../api/types';

/** “从未就绪”的会话：readyAt 为空，或 endReason ∈ {CANCELLED, PROVISION_FAILED, PROVISION_TIMEOUT}（没有报告，P08 返回 404）。 */
export function neverReady(v: Pick<SessionView, 'readyAt' | 'endReason'>): boolean {
  return !v.readyAt || v.endReason === 'CANCELLED' || v.endReason === 'PROVISION_FAILED' || v.endReason === 'PROVISION_TIMEOUT';
}

export type WorkspaceRender =
  /** P04 准备模式（REQUESTED、PROVISIONING） */
  | { screen: 'P04'; variant: 'preparing' }
  /** P04：“正在取消：释放已创建的资源” + CompensationProgress（未就绪的 ENDING / CLEANING） */
  | { screen: 'P04'; variant: 'compensating' }
  /** P04 红色 FailurePanel + “有资源未释放 [查看清单]” */
  | { screen: 'P04'; variant: 'cleanup-failed' }
  /** P04：“已取消实验 / 启动失败，已释放已创建的资源” + [重新开始]（未就绪的 ENDED） */
  | { screen: 'P04'; variant: 'ended' }
  /** P04 失败视图（FAILED） */
  | { screen: 'P04'; variant: 'failed' }
  /** P05 实验模式（READY、RUNNING、EXPIRING） */
  | { screen: 'P05'; variant: 'live' }
  /** P05 只读 + 覆盖层“实验已结束，正在收回访问并释放资源” */
  | { screen: 'P05'; variant: 'winding' }
  /** P05 只读 + 横幅“环境保留中 [管理保留]” */
  | { screen: 'P05'; variant: 'kept' }
  /** P05 只读 + 红色横幅 */
  | { screen: 'P05'; variant: 'cleanup-failed' }
  /** P05 只读存档 + “查看报告” */
  | { screen: 'P05'; variant: 'archive' };

export function workspaceRender(v: Pick<SessionView, 'state' | 'readyAt' | 'endReason'>): WorkspaceRender {
  const nr = neverReady(v);
  switch (v.state) {
    case 'REQUESTED':
    case 'PROVISIONING':
      return { screen: 'P04', variant: 'preparing' };
    case 'READY':
    case 'RUNNING':
    case 'EXPIRING':
      return { screen: 'P05', variant: 'live' };
    case 'ENDING':
    case 'CLEANING':
      return nr ? { screen: 'P04', variant: 'compensating' } : { screen: 'P05', variant: 'winding' };
    case 'KEPT':
      return { screen: 'P05', variant: 'kept' };
    case 'CLEANUP_FAILED':
      return nr ? { screen: 'P04', variant: 'cleanup-failed' } : { screen: 'P05', variant: 'cleanup-failed' };
    case 'ENDED':
      return nr ? { screen: 'P04', variant: 'ended' } : { screen: 'P05', variant: 'archive' };
    case 'FAILED':
      return { screen: 'P04', variant: 'failed' };
  }
}

export type EndRender =
  | { kind: 'redirect'; to: string }
  /** P07 回收进度（hash 为 `manual` 时定位待人工处理清单）；`report` = 是否显示报告链接 */
  | { kind: 'P07'; anchor: 'manual' | null; report: boolean }
  | { kind: 'P07-K' }
  /** P07 结束摘要（含复扫时间线） */
  | { kind: 'P07-summary'; report: boolean };

export function endRender(v: Pick<SessionView, 'sessionId' | 'state' | 'readyAt' | 'endReason'>): EndRender {
  const report = !neverReady(v);
  switch (v.state) {
    case 'REQUESTED':
    case 'PROVISIONING':
    case 'READY':
    case 'RUNNING':
    case 'EXPIRING':
      return { kind: 'redirect', to: `/workspace/${v.sessionId}` };
    case 'ENDING':
    case 'CLEANING':
      return { kind: 'P07', anchor: null, report };
    case 'KEPT':
      return { kind: 'P07-K' };
    case 'CLEANUP_FAILED':
      return { kind: 'P07', anchor: 'manual', report };
    case 'ENDED':
    case 'FAILED':
      return { kind: 'P07-summary', report };
  }
}

const TO_WORKSPACE: readonly SessionState[] = ['REQUESTED', 'PROVISIONING', 'READY', 'RUNNING', 'EXPIRING'];

/** 顶栏胶囊点击去向（表 2 最后一列）；终态不显示胶囊 → null。`overdue`：本地已到截止时间（仍回工作台）。 */
export function pillTarget(v: Pick<SessionView, 'sessionId' | 'state'>): string | null {
  if (TO_WORKSPACE.includes(v.state)) return `/workspace/${v.sessionId}`;
  if (v.state === 'ENDING' || v.state === 'CLEANING' || v.state === 'KEPT') return `/sessions/${v.sessionId}/end`;
  if (v.state === 'CLEANUP_FAILED') return `/sessions/${v.sessionId}/end#manual`;
  return null;
}

/** `/` 的重定向：有当前会话且处于表 2 前两行 → 工作台；否则卡片目录。 */
export function rootRedirect(current: Pick<SessionView, 'sessionId' | 'state'> | null | undefined): string {
  return current && TO_WORKSPACE.includes(current.state) ? `/workspace/${current.sessionId}` : '/labs';
}

export interface ActionContext {
  role: 'L' | 'A' | 'O' | null;
  /** 服务端时间。 */
  nowMs: number;
  uninstalling: boolean;
  budgetExceeded: boolean;
  /** 环境健康（02 §8.1：异常时不能保留）。 */
  envHealthy: boolean;
}

/**
 * allowedActions：优先用会话视图的同名字段（服务端说了算，§1.3 原则 1）；没有时按 02 §2.1 的状态表推导（§3.3）。
 * 只对学员非空；维护模式不影响这些动作（01 §4.7 只拒绝开始新会话）。
 */
export function allowedActionsOf(v: SessionView, ctx: ActionContext): AllowedAction[] {
  if (ctx.role !== 'L') return [];
  if (Array.isArray(v.allowedActions)) return v.allowedActions;
  const blocked = ctx.uninstalling || ctx.budgetExceeded;
  switch (v.state) {
    case 'REQUESTED':
    case 'PROVISIONING':
      return ['cancel'];
    case 'READY':
    case 'RUNNING':
    case 'EXPIRING': {
      const out: AllowedAction[] = ['end'];
      const deadline = v.deadlineAt ? Date.parse(v.deadlineAt) : Number.POSITIVE_INFINITY;
      const maxDeadline = v.limits?.maxDeadlineAt ? Date.parse(v.limits.maxDeadlineAt) : Number.POSITIVE_INFINITY;
      const left = v.limits?.extensionsLeft ?? 0;
      if (!blocked && left > 0 && ctx.nowMs < deadline - 30_000 && deadline < maxDeadline) out.push('extend');
      if (!blocked && ctx.envHealthy && v.limits?.keepAllowed !== false) out.push('end-keep');
      return out;
    }
    case 'KEPT':
      return blocked ? ['keep-release'] : ['keep-release', 'keep-extend'];
    case 'CLEANUP_FAILED':
      return ['cleanup-retry'];
    default:
      return [];
  }
}

export type ExtendBlockReason = 'state' | 'none' | 'last30s' | 'cap' | 'uninstalling' | 'budget';

/** “延长”置灰的原因（§3.3 会话菜单；文案见 i18n session.extendBlocked）。 */
export function extendBlockReason(v: SessionView, ctx: ActionContext): ExtendBlockReason | null {
  if (!['READY', 'RUNNING', 'EXPIRING'].includes(v.state)) return 'state';
  const deadline = v.deadlineAt ? Date.parse(v.deadlineAt) : Number.POSITIVE_INFINITY;
  if (deadline - ctx.nowMs <= 30_000) return 'last30s';
  if ((v.limits?.extensionsLeft ?? 0) <= 0) return 'none';
  if ((v.limits?.extensionMinutesLeft ?? 1) <= 0) return 'cap';
  if (ctx.uninstalling) return 'uninstalling';
  if (ctx.budgetExceeded) return 'budget';
  return null;
}
