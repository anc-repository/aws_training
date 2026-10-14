/**
 * 语言边界（09 §1.2）：订阅当前语言，切换时以语言为 key 重新挂载子树，使所有文案（包括模块级别名、useMemo 中的文案）
 * 一次性换成新语言。服务（认证、SessionSync、API 客户端）在 React 之外创建，不受影响。
 */
import { Fragment, type ReactNode } from 'react';
import { useLocale } from './hooks';

export function LocaleRoot({ children }: { children: ReactNode }) {
  const locale = useLocale();
  return <Fragment key={locale}>{children}</Fragment>;
}
