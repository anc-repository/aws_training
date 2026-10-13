/**
 * 空状态（08 §4.0）：一句“为什么是空的”+ 一个主按钮“下一步做什么”；不用插画。
 * `page` 用作整页内容（NotFound、RoleDenied 等）时标题渲染为 h1。
 */
import type { ReactNode } from 'react';

export interface EmptyStateProps {
  title?: ReactNode;
  /** 为什么是空的。 */
  children?: ReactNode;
  /** 下一步做什么（一个主按钮或链接）。 */
  action?: ReactNode;
  page?: boolean;
}

export function EmptyState({ title, children, action, page }: EmptyStateProps) {
  return (
    <div className="empty" data-empty="">
      {title ? page ? <h1 tabIndex={-1}>{title}</h1> : <b>{title}</b> : null}
      {children ? <p>{children}</p> : null}
      {action ? <div className="row">{action}</div> : null}
    </div>
  );
}
