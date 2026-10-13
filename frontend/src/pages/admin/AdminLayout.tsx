// 管理后台（F12）：应用层 RBAC（users.role=admin）；F12.albAuth（ALB authenticate-cognito）是组合子功能，条件不满足时说明缺了什么。
import { NavLink, Outlet } from 'react-router-dom';
import { Feature, Hint } from '../../capabilities/Feature';
import { ModuleBadge } from '../../capabilities/ModuleBadge';
import { useCaps } from '../../capabilities/useCapability';

export function AdminLayout() {
  const caps = useCaps();
  return (
    <>
      <div className="page-head">
        <div className="stack" style={{ gap: 4 }}>
          <h1>管理后台</h1>
          <div className="row">
            <ModuleBadge module="database" />
            {caps.modules['db-proxy']?.status !== 'off' && <ModuleBadge module="db-proxy" />}
            <ModuleBadge module="auth" />
          </div>
        </div>
      </div>
      <Feature
        id="F12.albAuth"
        fallback={<Hint>管理后台由应用层 RBAC 保护；ALB 认证未启用（{caps.features['F12.albAuth']?.reason ?? '需要 load-balancer + auth(cognito) + HTTPS 监听器（DEP-011）'}）</Hint>}
      >
        <p className="notice notice-ok">/admin* 已由 ALB authenticate-cognito 前置认证（F12.albAuth），应用层仍检查 admin 组。</p>
      </Feature>
      <nav className="tabs" aria-label="管理后台">
        <NavLink to="/admin/users">用户</NavLink>
        <NavLink to="/admin/outbox">邮件</NavLink>
        <NavLink to="/admin/jobs">任务</NavLink>
        <NavLink to="/admin/audit">审计</NavLink>
      </nav>
      <Outlet />
    </>
  );
}
