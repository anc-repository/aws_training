/**
 * P13 的整页状态与错误边界（08 P13 #4、#7、#8、#33；§4.0“权限不足”）：
 * ErrorBoundary（路由级：“页面出错了 · [重新加载] · 错误 ID”）、NotFoundPage、RoleDeniedPage、NoRolePage、PlatformUnavailablePage。
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { msg, t } from '../i18n';
import type { Role } from '../auth/jwt';
import { Button, EmptyState } from '../ui';

const p = msg.p13;

export function NotFoundPage() {
  return (
    <EmptyState
      page
      title={p.notFoundTitle}
      action={
        <Link className="btn" to="/labs">
          {msg.app.backToCatalog}
        </Link>
      }
    >
      {p.notFound}
    </EmptyState>
  );
}

export function RoleDeniedPage({ role }: { role: Role | null }) {
  return (
    <EmptyState
      page
      title={p.roleDeniedTitle}
      action={
        <Link className="btn" to="/labs">
          {msg.app.backToCatalog}
        </Link>
      }
    >
      {t(p.roleDenied, { role: role ? msg.roles[role] : '—' })}
    </EmptyState>
  );
}

export function NoRolePage({ onSignOut }: { onSignOut: () => void }) {
  return (
    <main className="pub" id="main">
      <EmptyState
        page
        title={p.noRoleTitle}
        action={
          <Button variant="primary" onClick={onSignOut}>
            {msg.account.signOut}
          </Button>
        }
      >
        {p.noRole}
      </EmptyState>
    </main>
  );
}

export function PlatformUnavailablePage({ onRetry }: { onRetry: () => void }) {
  return (
    <main className="pub" id="main">
      <EmptyState
        page
        title={p.platformUnavailableTitle}
        action={
          <Button icon="refresh" onClick={onRetry}>
            {msg.app.retry}
          </Button>
        }
      >
        {p.platformUnavailable}
      </EmptyState>
    </main>
  );
}

interface BoundaryState {
  error: Error | null;
  id: string | null;
}

/** 路由级错误边界：resetKey 变化（换路由）时自动复位。 */
export class ErrorBoundary extends Component<{ children: ReactNode; resetKey?: string }, BoundaryState> {
  override state: BoundaryState = { error: null, id: null };

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error, id: Math.random().toString(36).slice(2, 10) };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[atl-web] render error', this.state.id, error, info.componentStack);
  }

  override componentDidUpdate(prev: { resetKey?: string }): void {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null, id: null });
  }

  override render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <EmptyState
        page
        title={p.pageErrorTitle}
        action={
          <Button icon="refresh" onClick={() => window.location.reload()}>
            {msg.app.reload}
          </Button>
        }
      >
        {t(p.pageError, { id: this.state.id })}
      </EmptyState>
    );
  }
}
