/**
 * 富文本模板（09 §1.3）：`rich()` 把模板里的 `{name}` 换成 React 节点（例如带样式的 id、链接），语序由各语言的模板决定。
 * 纯文本的 `t()`、复数与占位工具在 text.ts（不依赖 React）。
 */
import { Fragment, createElement, type ReactNode } from 'react';
import { expandPlurals, type Vars } from './text';

export { placeholders, setTextLocale, t, type Vars } from './text';

/**
 * 把模板里的 `{name}` 换成 React 节点（`vars` 中的字符串与数字也可以）；用于“会话 {sid}”这类需要给占位加样式的文案。
 */
export function rich(template: string, vars: Record<string, ReactNode>): ReactNode {
  const plain: Vars = {};
  for (const [k, v] of Object.entries(vars)) if (typeof v === 'string' || typeof v === 'number') plain[k] = v;
  const text = template.includes(', plural,') ? expandPlurals(template, plain) : template;
  const parts: ReactNode[] = [];
  const re = /\{(\w+)\}/g;
  let last = 0;
  let i = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (!(m[1]! in vars)) continue;
    if (m.index > last) parts.push(text.slice(last, m.index));
    parts.push(createElement(Fragment, { key: `v${i++}` }, vars[m[1]!]));
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts.length === 1 ? parts[0] : createElement(Fragment, null, ...parts);
}
