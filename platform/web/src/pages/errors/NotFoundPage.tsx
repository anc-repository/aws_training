/**
 * P13 #33“页面不存在”（`*` 路由，在全局框架内；08 §2.3）与画面内的“没有这个对象”（会话、证书、实验记录不存在或不属于本安装）。
 * 地址保留，不重定向；给出回到卡片目录与我的实验两个出口。h1 可聚焦（路由切换后焦点移到这里，§8.2）。
 */
import type { ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { msg, rich } from '../../i18n';
import { EmptyState } from '../../ui';

export default function NotFoundPage() {
  const { pathname } = useLocation();
  return (
    <div className="stack-16" data-screen="P13-404">
      <EmptyState
        page
        title={msg.p13.notFoundTitle}
        action={
          <>
            <Link className="btn primary" to="/labs">
              {msg.app.backToCatalog}
            </Link>
            <Link className="btn" to="/sessions">
              {msg.frame.notFound.mySessions}
            </Link>
          </>
        }
      >
        {rich(msg.frame.notFound.body, { notFound: msg.p13.notFound, path: <span className="mono wrap-any">{pathname}</span> })}
      </EmptyState>
    </div>
  );
}

export interface MissingProps {
  /** “没有这个会话”“没有这张证书”…… */
  title: string;
  children?: ReactNode;
  back?: { to: string; label: string };
}

/** 画面内的 404：对象不存在或不属于本安装（08 P11-D 状态“会话不存在”）。 */
export function Missing({ title, children, back = { to: '/sessions', label: msg.frame.notFound.back } }: MissingProps) {
  return (
    <EmptyState
      page
      title={title}
      action={
        <Link className="btn" to={back.to}>
          {back.label}
        </Link>
      }
    >
      {children ?? msg.frame.notFound.missingBody}
    </EmptyState>
  );
}
