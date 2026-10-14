/**
 * 应用根：服务上下文 → 全局状态 → 路由（08 §2）。
 * `/` 的重定向（§2.4）：刚退出（Cognito 登出回调目前是根地址）→ /auth/signed-out；否则登录后按当前会话去工作台或卡片目录。
 */
import { Suspense, useEffect, useState, type ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Guarded, ProtectedShell, PublicShell } from '../components/Shells';
import type { SessionActionDialogs } from '../components/SessionActions';
import { Skeleton } from '../ui';
import { ServicesProvider, useAuth, useServices, useSessionSync } from './context';
import { GlobalStatusProvider } from './globalStatus';
import { NotFoundRoute, ROUTE_TABLE } from './routeTable';
import { SESSION_ACTION_DIALOGS } from './sessionActionDialogs';
import { rootRedirect } from './sessionRouting';
import type { Services } from './services';

function RootRedirect() {
  const { current, currentLoaded } = useSessionSync();
  if (!currentLoaded) return <Skeleton lines={3} />;
  return <Navigate to={rootRedirect(current)} replace />;
}

function SignedOutGate() {
  const { auth } = useServices();
  const [signedOut] = useState(() => auth.consumeSignedOutFlag());
  if (signedOut) return <Navigate to="/auth/signed-out" replace />;
  return <ProtectedShell layout="app" />;
}

export function AppRoutes({ dialogs = SESSION_ACTION_DIALOGS }: { dialogs?: SessionActionDialogs }) {
  const pub = ROUTE_TABLE.filter((r) => r.layout === 'public');
  const app = ROUTE_TABLE.filter((r) => r.layout === 'app');
  const ws = ROUTE_TABLE.filter((r) => r.layout === 'workspace');
  return (
    <Suspense fallback={<Skeleton lines={3} />}>
      <Routes>
        <Route element={<PublicShell />}>
          {pub.map((r) => (
            <Route key={r.path} path={r.path} element={<r.component />} />
          ))}
        </Route>
        <Route element={<SignedOutGate />}>
          <Route index element={<RootRedirect />} />
        </Route>
        <Route element={<ProtectedShell layout="app" dialogs={dialogs} />}>
          {app.map((r) => (
            <Route
              key={r.path}
              path={r.path}
              element={
                <Guarded roles={r.roles}>
                  <r.component />
                </Guarded>
              }
            />
          ))}
          <Route path="/settings" element={<Navigate to="/settings/profile" replace />} />
          <Route path="*" element={<NotFoundRoute />} />
        </Route>
        <Route element={<ProtectedShell layout="workspace" dialogs={dialogs} />}>
          {ws.map((r) => (
            <Route
              key={r.path}
              path={r.path}
              element={
                <Guarded roles={r.roles} workspace>
                  <r.component />
                </Guarded>
              }
            />
          ))}
        </Route>
      </Routes>
    </Suspense>
  );
}

/** 登录后启动 SessionSync，并清掉上一次登录留下的全局错误（P13 #5、#6）。 */
function SyncLifecycle() {
  const { sync, errors } = useServices();
  const auth = useAuth();
  const authed = auth.status === 'authenticated' && !auth.expired;
  useEffect(() => {
    if (!authed) return undefined;
    errors.set({ authExpired: null, reauth: null });
    sync.start();
    return () => sync.stop();
  }, [authed, sync, errors]);
  return null;
}

export function AppProviders({ services, children }: { services: Services; children: ReactNode }) {
  return (
    <ServicesProvider services={services}>
      <SyncLifecycle />
      <GlobalStatusProvider>{children}</GlobalStatusProvider>
    </ServicesProvider>
  );
}

export function App({ services }: { services: Services }) {
  return (
    <AppProviders services={services}>
      <BrowserRouter>
        <AppRoutes />
      </BrowserRouter>
    </AppProviders>
  );
}
