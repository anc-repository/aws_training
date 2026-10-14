/**
 * “粘贴到终端”的终端侧流程（03 §7.1；08 P05.4），供 workbench.pasteToTerminal 调用（Workspace.tsx 负责打开标签、对话框与播报）：
 *
 * 1. 目标终端 Ready（未打开时先打开；超时 → 不粘贴，改为复制）；
 * 2. **等 shell 显示提示符**（TerminalController.waitForPrompt）：新会话 Ready 时 shell 还没输出提示符，bracketedPasteMode
 *    仍为 false、忙闲也未知，这时判定会把多行命令误拒，或者在“新的终端子标签”里按非安全粘贴逐行执行；
 * 3. 按**当前要粘贴进去的终端**的状态判定（evaluatePaste）：reject → 说明（多行且不支持安全粘贴时改为复制）；confirm → 对话框；
 * 4. 对话框选“在新的终端子标签中粘贴”：新子标签 Ready 并显示提示符后，用新终端的状态**重新判定**，不沿用旧终端的决定。
 *    等不到提示符、仍不是 bracketed paste 时，多行一律拒绝并改为复制。
 */
import { evaluatePaste, normalizePasteText, type PasteDecision, type PasteMode, type PasteRejection, type TerminalTarget } from '../model/paste';
import type { ConfirmChoice } from '../workbench/PasteDialogs';
import type { TermSnapshot } from './controller';

/** TerminalController 中粘贴用到的部分（测试替身实现它即可）。 */
export interface PasteTerminal {
  ensureReady(): Promise<boolean>;
  waitForPrompt(): Promise<boolean>;
  getSnapshot(): Pick<TermSnapshot, 'phase' | 'busy' | 'instanceId' | 'runAs'>;
  readonly bracketedPaste: boolean;
  paste(text: string, execute?: boolean): boolean;
}

export type ConfirmDecision = Extract<PasteDecision, { kind: 'confirm' }>;

export interface PasteFlowInput {
  text: string;
  mode: PasteMode;
  danger?: boolean;
  target: TerminalTarget;
  expected: TerminalTarget | null;
  tmux: boolean;
  /** 本卡片内已勾选“不再询问”（每次判定时读取）。 */
  dontAskExecute: () => boolean;
}

export interface PasteFlowDeps<T extends PasteTerminal> {
  /** 目标终端当前（或刚打开）的子标签。 */
  terminal: T;
  /** “在新的终端子标签中粘贴”：新开一个子标签（达到上限时 null）。 */
  newSubTab(): T | null;
  /** 确认对话框（针对 `ctl` 这个终端的判定）。 */
  confirm(decision: ConfirmDecision, ctl: T): Promise<ConfirmChoice>;
  copy(text: string): Promise<boolean>;
}

export type PasteFlowResult<T> =
  | { kind: 'pasted'; ctl: T }
  | { kind: 'cancelled' }
  /** 终端没有连上（newTab = 新子标签没有连上）；命令已尽量复制。 */
  | { kind: 'not-connected'; newTab: boolean; copied: boolean }
  /** 判定拒绝；多行且不支持安全粘贴时命令已尽量复制。 */
  | { kind: 'rejected'; rejection: PasteRejection; copied: boolean }
  | { kind: 'failed' };

export async function runPaste<T extends PasteTerminal>(i: PasteFlowInput, d: PasteFlowDeps<T>): Promise<PasteFlowResult<T>> {
  let ctl = d.terminal;
  let newTab = false;
  if (!(await ctl.ensureReady())) return { kind: 'not-connected', newTab, copied: await d.copy(i.text) };
  for (;;) {
    await ctl.waitForPrompt();
    const snap = ctl.getSnapshot();
    if (snap.phase !== 'ready') return { kind: 'not-connected', newTab, copied: await d.copy(i.text) };
    const decision = evaluatePaste({
      text: i.text,
      mode: i.mode,
      danger: i.danger,
      target: i.target,
      expected: i.expected,
      terminal: { bracketedPaste: ctl.bracketedPaste, busy: snap.busy, tmux: i.tmux },
      dontAskExecute: i.dontAskExecute(),
    });
    if (decision.kind === 'reject') {
      const copied = decision.rejection.reason === 'multiline-unsafe' ? await d.copy(i.text) : false;
      return { kind: 'rejected', rejection: decision.rejection, copied };
    }
    if (decision.kind === 'confirm') {
      const choice = await d.confirm(decision, ctl);
      if (choice.action === 'cancel') return { kind: 'cancelled' };
      if (choice.action === 'newtab') {
        const n = d.newSubTab();
        if (!n || !(await n.ensureReady())) return { kind: 'not-connected', newTab: true, copied: await d.copy(i.text) };
        ctl = n;
        newTab = true;
        continue; // 新终端：等提示符后重新判定
      }
    }
    return ctl.paste(normalizePasteText(i.text), i.mode === 'execute') ? { kind: 'pasted', ctl } : { kind: 'failed' };
  }
}
