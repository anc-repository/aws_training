/**
 * xterm.js 的按需加载（03 §3.7；01 §13 `features/workspace/terminal/`）。终端组件 TerminalView 由 P05 的实现者编写，
 * 这里只负责：①只在工作台需要时动态加载 @xterm/xterm 与 @xterm/addon-fit（不进入首屏包）；②统一的创建参数
 * （minimumContrastRatio 4.5、等宽字体、终端 token 配色，08 §5.3 TerminalView、03 §2.9）；③生产 CSP `style-src 'self'`
 * 下的样式（08 V-4、03 §3.7.6、01 §10.6）：xterm.js 6 运行时创建的 `<style>` 改为可构造样式表（adoptedStyleSheets），
 * `setAttribute('style')` 改为 CSSOM，CSP 保持不变（`./cspStyles.ts`）。
 */
import type { ITerminalOptions, Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import { openWithAdoptedStyles, patchRowStyleWrites } from './cspStyles';

export interface XtermHandle {
  term: Terminal;
  fit: FitAddon;
  dispose(): void;
}

function cssVar(name: string, fallback: string): string {
  try {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
  } catch {
    return fallback;
  }
}

export function terminalOptions(fontSize = 14): ITerminalOptions {
  return {
    fontFamily: cssVar('--font-mono', 'monospace'),
    fontSize,
    minimumContrastRatio: 4.5,
    cursorBlink: false,
    scrollback: 5000,
    theme: {
      background: cssVar('--term-bg', '#1B1C1F'),
      foreground: cssVar('--term-fg', '#E9E7E2'),
      cursor: cssVar('--term-cursor', '#4FB3A9'),
      selectionBackground: cssVar('--term-selection', 'rgba(79,179,169,.35)'),
    },
  };
}

let warned = false;

/** 在容器中创建终端（动态加载 xterm 与样式表）。 */
export async function createXterm(container: HTMLElement, opts: ITerminalOptions = terminalOptions()): Promise<XtermHandle> {
  const [{ Terminal: TerminalCtor }, { FitAddon: FitCtor }] = await Promise.all([
    import('@xterm/xterm'),
    import('@xterm/addon-fit'),
    import('@xterm/xterm/css/xterm.css'),
  ]);
  const term = new TerminalCtor(opts);
  const fit = new FitCtor();
  term.loadAddon(fit);
  const doc = container.ownerDocument;
  const styles = openWithAdoptedStyles(doc, () => term.open(container));
  if (!patchRowStyleWrites(term) && !warned) {
    warned = true;
    console.warn('[atl] xterm.js: the DOM row style patch did not apply (xterm internals changed); true-colour cells may be blocked by the CSP');
  }
  fit.fit();
  return {
    term,
    fit,
    dispose: () => {
      fit.dispose();
      term.dispose();
      styles?.dispose();
    },
  };
}
