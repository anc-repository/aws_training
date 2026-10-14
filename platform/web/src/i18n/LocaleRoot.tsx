/**
 * 语言边界（09 §1.2）：订阅当前语言，切换时以语言为 key 重新挂载子树，使所有文案（包括模块级别名、useMemo 中的文案）
 * 一次性换成新语言。服务（认证、SessionSync、API 客户端）在 React 之外创建，不受影响。
 *
 * 视觉组件（图标、架构图、图表）的 `visual.*` 文案也跟随同一语言（VisualI18nProvider；没有 Provider 时它们读 `<html lang>`，
 * 这里显式传入，不依赖属性写入的先后）。
 */
import { Fragment, type ReactNode } from 'react';
import { VisualI18nProvider } from '../ui/glyphs/visualI18n';
import { useLocale } from './hooks';

export function LocaleRoot({ children }: { children: ReactNode }) {
  const locale = useLocale();
  return (
    <VisualI18nProvider lang={locale}>
      <Fragment key={locale}>{children}</Fragment>
    </VisualI18nProvider>
  );
}
