/**
 * 工作台上下文：
 * - `WorkspaceContext`：会话视图、角色、卡片内容、变量、步骤、工作台描述等数据（WorkspacePage 提供）；
 * - `Workbench`（03 §2.1 的前端接口）：手册渲染组件调用的 focusTab / pasteToTerminal / openConsole / runStepCheck，
 *   以及打开证据抽屉、对比实验抽屉、手动确认对话框。
 */
import { createContext, useContext } from 'react';
import type { AllowedAction, SessionView } from '../api/types';
import type { Role } from '../auth/jwt';
import type { WorkspaceRender } from '../app/sessionRouting';
import type { WorkspaceData } from './data/useWorkspaceData';
import type { PanelId } from './model/lab';
import type { PasteMode, TerminalTarget } from './model/paste';
import type { WorkspaceReporter } from './workbench/reporter';
import type { CheckRunner } from './manual/checkRunner';

export interface Guardrails {
  uninstalling: boolean;
  budgetExceeded: boolean;
  budgetWarn: boolean;
  budgetEndActive: boolean;
  envDegraded: boolean;
}

export interface OutageWindow {
  until: string;
  stepId: string | null;
  actionId: string | null;
  channel: string | null;
  reason: string | null;
}

export interface WorkspaceCtx {
  sid: string;
  view: SessionView;
  render: WorkspaceRender;
  role: Role | null;
  learner: boolean;
  /** 手册可交互（检测、粘贴）的前提：实验模式且会话未结束。 */
  live: boolean;
  /** 准备模式（P04）：手册只读，“粘贴到终端”“检测”禁用。 */
  preparing: boolean;
  /** 访问已收回（revokedAt，或会话已离开 READY～EXPIRING）：立即断开全部终端。到截止时间但尚未收回时只是只读（覆盖层）。 */
  accessRevoked: boolean;
  allowed: AllowedAction[];
  data: WorkspaceData;
  guard: Guardrails;
  outage: OutageWindow | null;
  now: () => number;
  reporter: WorkspaceReporter | null;
}

export const WorkspaceContext = createContext<WorkspaceCtx | null>(null);

export function useWorkspace(): WorkspaceCtx {
  const c = useContext(WorkspaceContext);
  if (!c) throw new Error('WorkspaceContext is missing');
  return c;
}

export interface PasteMeta {
  stepId: string | null;
  blockIndex: number;
  dangerous?: boolean;
  mode?: PasteMode;
  /** 在新的终端子标签中粘贴。 */
  newTab?: boolean;
  /** 命令块声明的运行位置映射出的目标（目标与 runsOn 不一致时提示）。 */
  expected?: TerminalTarget | null;
  unresolved?: readonly string[];
  secret?: boolean;
  secretPaths?: readonly string[];
}

export interface Workbench {
  focusTab(panel: PanelId, opts?: { user?: boolean }): void;
  /** 只粘贴不回车；被确认矩阵拒绝或取消时为 false。 */
  pasteToTerminal(tab: TerminalTarget, text: string, meta: PasteMeta): Promise<boolean>;
  openConsole(destination?: { linkId: string; params?: Record<string, string> }): void;
  runStepCheck(stepId: string, opts?: { checkIds?: string[]; force?: boolean }): void;
  runLabCheck(): void;
  openCheck(checkId: string): void;
  openExperiment(key: string): void;
  openManualConfirm(stepId: string, checkId: string): void;
  /** 定位到变量条（含未解析变量的命令块）。 */
  revealVariables(names: readonly string[]): void;
  /** 回到手册当前步骤标题（⌃. M）。 */
  focusManual(): void;
  /** 检测的发起与在途状态。 */
  checks: CheckRunner;
  /** 经“粘贴到终端”发出的命令在终端中结束（OSC 133 D）。 */
  onCommandFinished(cb: (e: CommandFinished) => void): () => void;
}

export interface CommandFinished {
  stepId: string | null;
  tab: TerminalTarget;
  exitCode: number | null;
}

export const WorkbenchContext = createContext<Workbench | null>(null);

export function useWorkbench(): Workbench {
  const c = useContext(WorkbenchContext);
  if (!c) throw new Error('WorkbenchContext is missing');
  return c;
}
