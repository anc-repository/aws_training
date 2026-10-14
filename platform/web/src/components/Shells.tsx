/**
 * 页面骨架（08 §3.1）：
 * - ProtectedShell：先按 §2.4 表 1 第 1～4 条判断（未登录 → /login；没有角色；平台不可用），通过后渲染
 *   `app` 布局（顶栏 GlobalBar + 横幅区 + 主内容 ≤ 1440px + 页脚）或 `workspace` 布局（无顶栏与页脚，由 P05 的 SessionBar 承担）；
 * - Guarded：每个路由的第 5～7 条（首次设置、角色），角色不足显示 RoleDeniedPage（保留地址）；
 * - PublicShell：/login、/auth/*（不加载顶栏）。
 * 地标：header（顶栏）、nav、main、footer；页面顶部“跳到主要内容”；路由切换后焦点移到 h1（§8.2）。
 */
import { Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth, useServices, useSessionSync } from '../app/context';
import { evaluateAccess, evaluateRoute } from '../app/guards';
import { useGlobalStatus } from '../app/globalStatus';
import type { Role } from '../auth/jwt';
import { msg } from '../i18n';
import { LanguageSwitcher } from '../i18n/LanguageSwitcher';
import { ssGet, ssSet } from '../lib/storage';
import { BannerStack, Icon, LiveRegion, Skeleton, type BannerSpec } from '../ui';
import { ErrorBoundary, NoRolePage, PlatformUnavailablePage, RoleDeniedPage } from './ErrorPages';
import { GlobalBar } from './GlobalBar';
import { computeGlobalBanners } from './globalBanners';
import { GlobalDialogs } from './GlobalDialogs';
import { useEnvDegraded, useExpiryAnnouncements, useGlobalShortcuts } from './globalHooks';
import { SessionActionsProvider, type SessionActionDialogs } from './SessionActions';
import { FooterStatus, OfflineBar } from './StatusBars';

function useHere(): string {
  const loc = useLocation();
  return `${loc.pathname}${loc.search}${loc.hash}`;
}

/** 路由切换后焦点移到 h1（首次加载不抢焦点）；工作台由 P05 自己把焦点放到手册当前步骤标题。 */
function useRouteFocus(enabled: boolean): void {
  const { pathname } = useLocation();
  const first = useRef(true);
  useEffect(() => {
    if (!enabled) return undefined;
    if (first.current) {
      first.current = false;
      return undefined;
    }
    let tries = 0;
    let raf = 0;
    const attempt = () => {
      const h = document.querySelector<HTMLElement>('main h1');
      if (h) {
        if (!h.hasAttribute('tabindex')) h.setAttribute('tabindex', '-1');
        h.focus();
      } else if (tries++ < 30) raf = requestAnimationFrame(attempt);
    };
    raf = requestAnimationFrame(attempt);
    return () => cancelAnimationFrame(raf);
  }, [pathname, enabled]);
}

function FullPageLoading() {
  return (
    <main className="pub" id="main">
      <Skeleton lines={4} block />
    </main>
  );
}

function GlobalBannerStack() {
  const { clock } = useServices();
  const auth = useAuth();
  const { current } = useSessionSync();
  const status = useGlobalStatus();
  const envDegraded = useEnvDegraded();
  const { pathname } = useLocation();
  const banners = computeGlobalBanners({
    role: auth.principal?.role ?? null,
    platform: status.platform.data,
    guardrails: status.guardrails,
    current,
    nowMs: clock.now(),
    onWorkspace: pathname.startsWith('/workspace/'),
    manual: status.manual,
    catalogUpdatedTo: status.catalogUpdatedTo,
    envDegraded,
  });
  const specs: BannerSpec[] = banners.map((b) => ({
    id: b.id,
    priority: b.priority,
    tone: b.tone,
    shape: b.shape,
    text: b.text,
    dismissible: b.dismissible,
    action: b.action ? (
      b.action.reload ? (
        <button type="button" className="btn sm" onClick={() => window.location.reload()}>
          {b.action.label}
        </button>
      ) : (
        <Link className="btn sm" to={b.action.to ?? '/'}>
          {b.action.label}
        </Link>
      )
    ) : undefined,
  }));
  return <BannerStack banners={specs} />;
}

function AppChrome() {
  const { pathname } = useLocation();
  const { me } = useGlobalStatus();
  useRouteFocus(true);
  useExpiryAnnouncements();
  useGlobalShortcuts({ enabled: true, currentTrackId: me?.currentTrackId ?? 'saa-main' });
  return (
    <div className="shell atl-shell">
      <a className="skip" href="#main">
        {msg.app.skipToMain}
      </a>
      <GlobalBar />
      <OfflineBar />
      <div className="shell-body">
        <GlobalBannerStack />
        <main id="main" className="page" tabIndex={-1}>
          <ErrorBoundary resetKey={pathname}>
            <Suspense fallback={<Skeleton lines={4} block />}>
              <Outlet />
            </Suspense>
          </ErrorBoundary>
        </main>
      </div>
      <FooterStatus />
      <GlobalDialogs />
      <LiveRegion />
    </div>
  );
}

function WorkspaceChrome() {
  const { pathname } = useLocation();
  useExpiryAnnouncements();
  return (
    <div className="ws-root">
      <a className="skip" href="#main">
        {msg.app.skipToMain}
      </a>
      <OfflineBar />
      <main id="main" className="ws" tabIndex={-1}>
        <ErrorBoundary resetKey={pathname}>
          <Suspense fallback={<Skeleton lines={4} block />}>
            <Outlet />
          </Suspense>
        </ErrorBoundary>
      </main>
      <GlobalDialogs />
      <LiveRegion />
    </div>
  );
}

export interface ProtectedShellProps {
  layout: 'app' | 'workspace';
  /** 会话动作对话框的实现（P04、P05.9 注册）；默认是“将在后续实现”的说明对话框。 */
  dialogs?: SessionActionDialogs;
}

export function ProtectedShell({ layout, dialogs }: ProtectedShellProps) {
  const { auth } = useServices();
  const snap = useAuth();
  const status = useGlobalStatus();
  const here = useHere();
  if (snap.status === 'initializing') return <FullPageLoading />;
  const decision = evaluateAccess({
    location: here,
    auth: { authenticated: snap.status === 'authenticated', hadSession: snap.hadSession, signedOutElsewhere: snap.signedOutElsewhere },
    principal: snap.principal,
    platform: { status: status.platform.status, mode: status.platform.data?.mode ?? null },
  });
  switch (decision.kind) {
    case 'redirect':
      return <Navigate to={decision.to} replace />;
    case 'no-role':
      return <NoRolePage onSignOut={() => void auth.signOut()} />;
    case 'platform-unavailable':
      return <PlatformUnavailablePage onRetry={status.retryPlatform} />;
    case 'loading':
      return <FullPageLoading />;
    default:
      return <SessionActionsProvider dialogs={dialogs}>{layout === 'app' ? <AppChrome /> : <WorkspaceChrome />}</SessionActionsProvider>;
  }
}

export interface GuardedProps {
  roles: readonly Role[];
  workspace?: boolean;
  children: ReactNode;
}

/** 表 1 第 5～7 条（在 ProtectedShell 之内）。 */
export function Guarded({ roles, workspace, children }: GuardedProps) {
  const snap = useAuth();
  const status = useGlobalStatus();
  const here = useHere();
  const role = snap.principal?.role ?? null;
  if (role === 'L' && !status.meLoaded) return <Skeleton lines={3} />;
  const d = evaluateRoute({
    location: here,
    principal: snap.principal,
    platform: { status: status.platform.status, mode: status.platform.data?.mode ?? null },
    onboardingDone: status.onboardingDone,
    route: { roles, workspace },
  });
  if (d.kind === 'redirect') return <Navigate to={d.to} replace />;
  if (d.kind === 'role-denied') return <RoleDeniedPage role={role} />;
  if (d.kind !== 'allow') return <Skeleton lines={3} />;
  return (
    <>
      {d.onboardingNotice ? <OnboardingNotice /> : null}
      {children}
    </>
  );
}

/** 工作台内一次可关闭的提示（表 1 第 6 条）；关闭记在本标签页。 */
function OnboardingNotice() {
  const [hidden, setHidden] = useState(() => ssGet<boolean>('atl.onboarding-notice.v1', false));
  if (hidden) return null;
  return (
    <div className="note blue no-print" role="note" data-onboarding-notice="">
      <span className="spacer">{msg.frame.onboarding}</span>
      <button
        type="button"
        className="btn sm ghost icon"
        aria-label={msg.banners.dismiss}
        onClick={() => {
          ssSet('atl.onboarding-notice.v1', true);
          setHidden(true);
        }}
      >
        <Icon name="x" />
      </button>
    </div>
  );
}

export function PublicShell() {
  return (
    <div className="shell">
      <div className="pub-lang">
        <LanguageSwitcher />
      </div>
      <main id="main" className="pub" tabIndex={-1}>
        <Suspense fallback={<Skeleton lines={3} />}>
          <Outlet />
        </Suspense>
      </main>
      <LiveRegion />
    </div>
  );
}
