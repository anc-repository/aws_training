/**
 * “粘贴到终端”的确认矩阵（03 §7.1；08 P05.4，前端实现于 workbench.pasteToTerminal）。纯函数，分两段：
 *
 * 1. `precheckPaste`：与终端状态无关的拒绝条件——含未解析变量、含密钥占位、超过 16KB、危险命令“粘贴并执行”；
 * 2. `evaluatePaste`：目标终端就绪后，按终端状态（bracketed paste、OSC 133 忙闲、tmux）与命令性质给出确认要求。
 *
 * 默认只粘贴、不回车（bracketed paste 包裹，末尾换行去掉）；“粘贴并执行”需在设置中开启，单行普通命令可勾选“本卡片内不再询问”。
 */

export type TerminalTarget = 'lab' | 'workstation';
export type PasteMode = 'paste' | 'execute';

export const PASTE_LIMIT_BYTES = 16 * 1024;

/** 危险命令的启发式（03 §7.1）。 */
const DANGER_PATTERNS: readonly RegExp[] = [
  /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\b/,
  /\brm\s+-rf\b/,
  /\bdelete-[a-z0-9-]+/,
  /\bterminate-[a-z0-9-]+/,
  /\bscripts\/module\s+disable\b/,
  /\bscripts\/module\s+env\s+destroy\b/,
  /\benv\s+destroy\b/,
  /\bscripts\/teardown\b/,
  /--purge\b/,
  /\bs3\s+rb\b/,
  /\bs3\s+rm\b.*--recursive/,
];

export function looksDangerous(text: string): boolean {
  return DANGER_PATTERNS.some((re) => re.test(text));
}

/** 去掉末尾换行（03 §7.1：末尾换行一律去掉，学员自己按 Enter）。 */
export function normalizePasteText(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\n+$/g, '');
}

export function lineCount(text: string): number {
  return normalizePasteText(text).split('\n').length;
}

export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

export type PasteRejection =
  | { reason: 'unresolved'; names: string[]; message: string }
  | { reason: 'secret'; message: string; readCommand: string | null }
  | { reason: 'too-large'; message: string }
  | { reason: 'danger-execute'; message: string }
  | { reason: 'multiline-unsafe'; message: string };

export interface PrecheckInput {
  text: string;
  mode: PasteMode;
  /** 手册声明的 danger=true。 */
  danger?: boolean;
  unresolved?: readonly string[];
  secret?: boolean;
  /** 含密钥占位的变量路径（`envfile.<module>.<KEY>`），用来给出在实例上读取的命令。 */
  secretPaths?: readonly string[];
}

/** 在实验机上读取密钥的命令（`envfile.<module>.<KEY>` → modules.d 中的那一行）。 */
export function secretReadCommand(paths: readonly string[] | undefined): string | null {
  const p = paths?.find((x) => x.startsWith('envfile.'));
  if (!p) return null;
  const [, mod, key] = p.split('.');
  if (!mod || !key || !/^[a-z0-9-]+$/.test(mod) || !/^[A-Z0-9_]+$/.test(key)) return null;
  return `sudo grep '^${key}=' /etc/cloudalbum/modules.d/${mod}.env`;
}

export function precheckPaste(i: PrecheckInput): PasteRejection | null {
  if (i.unresolved?.length) return { reason: 'unresolved', names: [...i.unresolved], message: `有 ${i.unresolved.length} 个变量未填写，已定位到变量条` };
  if (i.secret)
    return {
      reason: 'secret',
      message: '命令含密钥占位，不能粘贴。请在实验机上读取密钥后手动输入。',
      readCommand: secretReadCommand(i.secretPaths),
    };
  if (byteLength(i.text) > PASTE_LIMIT_BYTES) return { reason: 'too-large', message: '命令超过 16KB，只能复制' };
  if (i.mode === 'execute' && (i.danger || looksDangerous(i.text))) return { reason: 'danger-execute', message: '危险命令不允许“粘贴并执行”，请粘贴后检查再自己按 Enter' };
  return null;
}

export interface TerminalPasteState {
  /** xterm.js `modes.bracketedPasteMode`。 */
  bracketedPaste: boolean;
  /** OSC 133：收到 C（命令开始）而未收到 D（命令结束）。 */
  busy: boolean;
  /** 终端处于 tmux 中：无法判断忙闲（03 §7.1）。 */
  tmux: boolean;
}

export type ConfirmNote = 'execute' | 'multiline' | 'danger' | 'busy' | 'mismatch';

export type PasteDecision =
  | { kind: 'reject'; rejection: PasteRejection }
  | { kind: 'paste' }
  | {
      kind: 'confirm';
      notes: ConfirmNote[];
      /** 红色确认对话框（危险命令），主按钮“我了解，粘贴”。 */
      severe: boolean;
      lines: number;
      /** 终端正忙时提供“在新的终端子标签中粘贴”。 */
      offerNewTab: boolean;
      /** “本卡片内不再询问（仅普通命令）”勾选框。 */
      offerDontAsk: boolean;
    };

export interface EvaluateInput extends PrecheckInput {
  /** 学员选的目标终端。 */
  target: TerminalTarget;
  /** 命令块声明的运行位置映射出的目标（null = 只能复制）。 */
  expected: TerminalTarget | null;
  terminal: TerminalPasteState;
  /** 本卡片内已勾选“不再询问”（只对单行普通命令的“粘贴并执行”生效）。 */
  dontAskExecute?: boolean;
}

export function evaluatePaste(i: EvaluateInput): PasteDecision {
  const pre = precheckPaste(i);
  if (pre) return { kind: 'reject', rejection: pre };
  const text = normalizePasteText(i.text);
  const lines = lineCount(text);
  const multi = lines > 1;
  const danger = !!i.danger || looksDangerous(text);
  if (multi && !i.terminal.bracketedPaste)
    return { kind: 'reject', rejection: { reason: 'multiline-unsafe', message: '当前程序不支持安全粘贴，请复制后手动粘贴' } };
  const notes: ConfirmNote[] = [];
  if (i.expected && i.expected !== i.target) notes.push('mismatch');
  if (i.terminal.busy && !i.terminal.tmux) notes.push('busy');
  if (danger) notes.push('danger');
  else if (multi) notes.push('multiline');
  if (i.mode === 'execute' && !danger) {
    const ordinary = !multi;
    if (!(ordinary && i.dontAskExecute)) notes.push('execute');
  }
  if (!notes.length) return { kind: 'paste' };
  return {
    kind: 'confirm',
    notes,
    severe: danger,
    lines,
    offerNewTab: notes.includes('busy'),
    offerDontAsk: i.mode === 'execute' && !danger && !multi,
  };
}

export const TARGET_TEXT: Readonly<Record<TerminalTarget, string>> = { lab: '实验机', workstation: '工作台' };

/** runsOn → 目标终端（03 §7.1 目标映射；local / browser 只能复制）。 */
export function targetOfRunsOn(runsOn: string | null | undefined): TerminalTarget | null {
  switch (runsOn ?? 'workstation') {
    case 'workstation':
    case 'ops':
    case 'cloudshell':
      return 'workstation';
    case 'lab':
    case 'ec2':
      return 'lab';
    default:
      return null;
  }
}

/** 粘贴的事件上报所需的命令摘要（`textSha256`，03 §7.4；不上报命令原文）。 */
export async function sha256Hex(text: string): Promise<string> {
  try {
    const d = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return '';
  }
}
