/**
 * 手册代码块（04 §4.3 代码块属性；08 P05.4）：代入变量（`vars=false` 时不代入）→ CommandBlock。
 * 复制用原文、显示经过打码器；`runsOn` 决定“粘贴到 工作台 / 实验机”；粘贴走 workbench.pasteToTerminal（确认矩阵）。
 * 准备阶段与只读状态下粘贴禁用（悬停说明“环境就绪后可用”）；没有 runsOn 的示例输出（lang 不是 shell）只能复制。
 */
import { useContext } from 'react';
import { CommandBlock, type RunsOn } from '../../ui';
import { WorkbenchContext, WorkspaceContext } from '../context';
import type { MdNode } from '../model/lab';
import { targetOfRunsOn } from '../model/paste';
import { resolveTemplate } from '../model/vars';
import type { RenderEnv } from './Mdast';

import { W } from '../strings';
const SHELL_LANGS = new Set(['bash', 'sh', 'shell', 'zsh', 'console']);

export function codeAttrs(n: MdNode): { runsOn: RunsOn | null; copy: boolean; vars: boolean; danger: boolean } {
  const a = n.attributes ?? {};
  const meta = n.meta ?? '';
  const pick = (k: string): string | undefined => {
    const v = a[k];
    if (v !== undefined && v !== null) return String(v);
    const m = new RegExp(`(?:^|[\\s{])${k}=([^\\s}]+)`).exec(meta);
    return m?.[1];
  };
  const runsOnRaw = pick('runsOn');
  const runsOn = (runsOnRaw ?? (SHELL_LANGS.has((n.lang ?? '').toLowerCase()) ? 'workstation' : null)) as RunsOn | null;
  return { runsOn, copy: pick('copy') !== 'false', vars: pick('vars') !== 'false', danger: pick('danger') === 'true' || /\bdanger\b(?!=)/.test(meta) };
}

export function ManualCommand({ node, env }: { node: MdNode; env: RenderEnv }) {
  const ws = useContext(WorkspaceContext);
  const wb = useContext(WorkbenchContext);
  const a = codeAttrs(node);
  const text = node.value ?? '';
  const r = resolveTemplate(text, env.vars, a.vars);
  const blockIndex = env.blockIndex.get(node) ?? 0;
  const pasteDisabledReason = !ws ? W.command.afterReady : ws.preparing ? W.command.afterReady : !ws.learner ? W.command.role : !ws.live ? W.command.ended : null;
  const expected = targetOfRunsOn(a.runsOn);
  const observe = env.step?.type === 'experiment' && (a.runsOn === 'lab' || a.runsOn === 'ec2');
  const secretPaths = r.parts.filter((p) => typeof p !== 'string' && p.secret).map((p) => (p as { name: string }).name);
  if (!a.copy && !a.runsOn) {
    return (
      <pre className="mono small snippet">
        <code>{r.text}</code>
      </pre>
    );
  }
  return (
    <CommandBlock
      parts={r.parts}
      runsOn={a.runsOn ?? 'local'}
      danger={a.danger}
      observe={observe}
      copyOnly={!a.runsOn || !expected}
      pasteDisabledReason={pasteDisabledReason}
      allowExecute={ws?.learner ? executeEnabled() : false}
      onUnresolved={(names) => wb?.revealVariables(names)}
      onPaste={
        wb
          ? (target, opts) =>
              void wb.pasteToTerminal(target, r.text, {
                stepId: env.step?.id ?? null,
                blockIndex,
                dangerous: a.danger,
                mode: opts.execute ? 'execute' : 'paste',
                newTab: opts.newTab,
                expected,
                unresolved: r.unresolved,
                secret: r.secret,
                secretPaths,
              })
          : undefined
      }
    />
  );
}

/** “粘贴并执行”在设置中开启后才出现（03 §7.1）；偏好存 localStorage（终端设置，⋯ 菜单）。 */
export const EXECUTE_PREF_KEY = 'atl.ws.paste-execute.v1';

export function executeEnabled(): boolean {
  try {
    return globalThis.localStorage?.getItem(EXECUTE_PREF_KEY) === 'true';
  } catch {
    return false;
  }
}
