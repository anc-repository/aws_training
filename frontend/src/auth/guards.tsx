// 路由守卫：未登录跳到 /login?next=…；非管理员显示 403 说明（F12 的应用层 RBAC 在后端，这里只是 UX）。
import type { ReactNode } from 'react';
import { Link, Navigate, useLocation } from 'react-router-dom';
import { useAuth } from './context';

export function RequireAuth({ children, allowRestricted = false }: { children: ReactNode; allowRestricted?: boolean }) {
  const { user, loading } = useAuth();
  const loc = useLocation();
  if (loading) return <div className="skeleton" style={{ height: 120 }} aria-busy="true" />;
  if (!user) return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname + loc.search)}`} replace />;
  if (user.restricted && !allowRestricted) {
    return (
      <div className="card panel-narrow">
        <h1>请先完成邮箱验证</h1>
        <p className="muted">当前是注册后的受限会话，只能查看发给你的邮件。</p>
        <Link className="btn btn-primary" to="/me/outbox">打开我的邮件</Link>
      </div>
    );
  }
  return <>{children}</>;
}

export function RequireAdmin({ children }: { children: ReactNode }) {
  const { isAdmin } = useAuth();
  return (
    <RequireAuth>
      {isAdmin ? children : (
        <div className="card panel-narrow" role="alert">
          <h1>没有权限</h1>
          <p className="muted">这个页面仅管理员可用（应用层 RBAC：users.role = admin）。</p>
        </div>
      )}
    </RequireAuth>
  );
}
