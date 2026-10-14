/**
 * 语言边界（09 §1.2）：订阅当前语言，切换时让整个应用**原地重新渲染**（不重新挂载）。
 *
 * - 词典叶子在切换时原地改写（runtime.ts），模块级别名（`const S = msg.labs.ui`）与组件里的 `msg.*` 在重新渲染时自然取到新语言；
 * - 子元素每次都换成一个新的元素对象（同类型、同 key、同属性），React 不会因为 props 相同而跳过它，渲染沿树向下传播；
 *   组件状态、终端连接（SSM 会话）、对话框里的输入、展开状态都保留（重新挂载会卸载 TerminalPane 并结束 SSM 会话）；
 * - 依赖文案的 useMemo 把 `useLocale()` 放进依赖；按语言读取的数据（内容 JSON、API）由各数据 hook 在语言变化时就地重取，
 *   新数据到达前保留旧数据（pages/labs/data.ts、pages/sessions/data.ts、workspace/data/resource.ts）。
 *
 * 视觉组件（图标、架构图、图表）的 `visual.*` 文案也跟随同一语言（VisualI18nProvider；没有 Provider 时它们读 `<html lang>`，
 * 这里显式传入，不依赖属性写入的先后）。
 */
import { cloneElement, isValidElement, type ReactNode } from 'react';
import { VisualI18nProvider } from '../ui/glyphs/visualI18n';
import { useLocale } from './hooks';

/** 新的元素对象（同类型、key、属性）：父组件重新渲染时不会被当成“没有变化”而跳过。 */
function renew(node: ReactNode): ReactNode {
  if (Array.isArray(node)) return node.map(renew);
  return isValidElement(node) ? cloneElement(node) : node;
}

export function LocaleRoot({ children }: { children: ReactNode }) {
  const locale = useLocale();
  return <VisualI18nProvider lang={locale}>{renew(children)}</VisualI18nProvider>;
}
