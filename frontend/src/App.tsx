// 应用根：CapabilitiesProvider（先加载 /api/capabilities 与注册表，期间显示骨架屏）→ AuthProvider（按 auth.driver 选择实现）
// → 路由。/lab 与 /admin 按路由懒加载；L0 首屏包里没有任何 AWS 代码（总纲 12.1）。
import { lazy, Suspense, type ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, RequireAdmin, RequireAuth } from './auth';
import { BootSkeleton, CapabilitiesProvider } from './capabilities/CapabilitiesProvider';
import { Layout } from './components/Layout';
import { AlbumList, AlbumPage } from './pages/Album';
import { Feed } from './pages/Feed';
import { ForgotPage, LoginPage, ResetPage } from './pages/Login';
import { MyOutboxPage } from './pages/MyOutbox';
import { NotFound } from './pages/NotFound';
import { NotificationsPage } from './pages/Notifications';
import { PhotoPage } from './pages/Photo';
import { RegisterPage, VerifyPage } from './pages/Register';
import { SharePage } from './pages/Share';
import { UploadPage } from './pages/Upload';

const lab = () => import('./lab');
const admin = () => import('./pages/admin');
const LabHome = lazy(() => lab().then((m) => ({ default: m.LabHome })));
const ModuleDetail = lazy(() => lab().then((m) => ({ default: m.ModuleDetail })));
const LabResults = lazy(() => lab().then((m) => ({ default: m.LabResults })));
const LabCompare = lazy(() => lab().then((m) => ({ default: m.LabCompare })));
const LabTrace = lazy(() => lab().then((m) => ({ default: m.LabTrace })));
const AdminLayout = lazy(() => admin().then((m) => ({ default: m.AdminLayout })));
const AdminUsers = lazy(() => admin().then((m) => ({ default: m.AdminUsers })));
const AdminOutbox = lazy(() => admin().then((m) => ({ default: m.AdminOutbox })));
const AdminJobs = lazy(() => admin().then((m) => ({ default: m.AdminJobs })));
const AdminAudit = lazy(() => admin().then((m) => ({ default: m.AdminAudit })));

function Lazy({ children }: { children: ReactNode }) {
  return <Suspense fallback={<div className="skeleton" style={{ height: 240 }} aria-busy="true" />}>{children}</Suspense>;
}

export function AppRoutes() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Feed />} />
        <Route path="login" element={<LoginPage />} />
        <Route path="register" element={<RegisterPage />} />
        <Route path="verify" element={<VerifyPage />} />
        <Route path="forgot" element={<ForgotPage />} />
        <Route path="reset" element={<ResetPage />} />
        <Route path="albums" element={<RequireAuth><AlbumList /></RequireAuth>} />
        <Route path="albums/:id" element={<AlbumPage />} />
        <Route path="photos/:id" element={<PhotoPage />} />
        <Route path="upload" element={<RequireAuth><UploadPage /></RequireAuth>} />
        <Route path="notifications" element={<RequireAuth><NotificationsPage /></RequireAuth>} />
        <Route path="me/outbox" element={<RequireAuth allowRestricted><MyOutboxPage /></RequireAuth>} />
        <Route path="s/:token" element={<SharePage />} />
        <Route path="share/:token" element={<SharePage />} />
        <Route path="admin" element={<RequireAdmin><Lazy><AdminLayout /></Lazy></RequireAdmin>}>
          <Route index element={<Navigate to="users" replace />} />
          <Route path="users" element={<Lazy><AdminUsers /></Lazy>} />
          <Route path="outbox" element={<Lazy><AdminOutbox /></Lazy>} />
          <Route path="jobs" element={<Lazy><AdminJobs /></Lazy>} />
          <Route path="audit" element={<Lazy><AdminAudit /></Lazy>} />
        </Route>
        <Route path="lab" element={<RequireAuth><Lazy><LabHome /></Lazy></RequireAuth>} />
        <Route path="lab/m/:id" element={<RequireAuth><Lazy><ModuleDetail /></Lazy></RequireAuth>} />
        <Route path="lab/results" element={<RequireAuth><Lazy><LabResults /></Lazy></RequireAuth>} />
        <Route path="lab/compare" element={<RequireAuth><Lazy><LabCompare /></Lazy></RequireAuth>} />
        <Route path="lab/trace" element={<Lazy><LabTrace /></Lazy>} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}

export function App() {
  return (
    <CapabilitiesProvider fallback={<BootSkeleton />}>
      <AuthProvider>
        <BrowserRouter>
          <AppRoutes />
        </BrowserRouter>
      </AuthProvider>
    </CapabilitiesProvider>
  );
}
