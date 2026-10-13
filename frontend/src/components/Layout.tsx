// 页面框架：页头（导航、铃铛、主题、用户菜单）→ 横幅（校验警告 / 不安全实验模式）→ 内容 → 页脚状态条 → 路径追踪抽屉。
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { notificationsApi } from '../api/endpoints';
import { useAuth } from '../auth/context';
import { ModuleBadge } from '../capabilities/ModuleBadge';
import { useCaps } from '../capabilities/useCapability';
import { nextTheme, setPrefs, THEME_LABEL, usePrefs } from '../prefs';
import { TraceDrawer } from '../trace/TraceDrawer';
import { useTraces } from '../trace/TraceStore';
import { entryChainLabel, shortId } from '../util/format';
import { AlbumMark, BellIcon, MenuIcon, MonitorIcon, MoonIcon, SunIcon, UserIcon } from './Icons';

export function Layout() {
  return (
    <div className="app">
      <a className="skip-link" href="#main">跳到主要内容</a>
      <Header />
      <Banners />
      <main id="main" className="main" tabIndex={-1}>
        <Outlet />
      </main>
      <FooterStatus />
      <TraceDrawer />
    </div>
  );
}

function useUnreadCount(enabled: boolean): number {
  const [count, setCount] = useState(0);
  const loc = useLocation();
  useEffect(() => {
    if (!enabled) {
      setCount(0);
      return undefined;
    }
    let cancelled = false;
    const tick = () => {
      if (globalThis.document?.visibilityState === 'hidden') return;
      notificationsApi.unreadCount().then((r) => { if (!cancelled) setCount(r.count); }, () => undefined);
    };
    tick();
    const t = setInterval(tick, 30_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [enabled, loc.pathname]);
  return count;
}

function Header() {
  const auth = useAuth();
  const caps = useCaps();
  const prefs = usePrefs();
  const navigate = useNavigate();
  const loc = useLocation();
  const [navOpen, setNavOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const user = auth.user;
  const unread = useUnreadCount(Boolean(user && !user.restricted));
  const outboxDriver = caps.modules.email?.driver === 'outbox';

  useEffect(() => {
    setNavOpen(false);
    setMenuOpen(false);
  }, [loc.pathname]);

  useEffect(() => {
    if (!menuOpen) return undefined;
    const onDoc = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenuOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  const logout = useCallback(async () => {
    await auth.logout();
    navigate('/');
  }, [auth, navigate]);

  const ThemeIcon = prefs.theme === 'dark' ? MoonIcon : prefs.theme === 'light' ? SunIcon : MonitorIcon;

  return (
    <header className="header">
      <button type="button" className="icon-btn nav-toggle" aria-label="导航菜单" aria-expanded={navOpen} onClick={() => setNavOpen((v) => !v)}>
        <MenuIcon />
      </button>
      <Link to="/" className="brand"><AlbumMark className="brand-mark" />CloudAlbum</Link>
      <nav className={`nav ${navOpen ? 'open' : ''}`} aria-label="主导航">
        <NavLink to="/" end>时间线</NavLink>
        {user && !user.restricted && <NavLink to="/albums">相册</NavLink>}
        {user && !user.restricted && <NavLink to="/upload">上传</NavLink>}
        {user && !user.restricted && <NavLink to="/lab">实验室</NavLink>}
        {auth.isAdmin && <NavLink to="/admin">管理</NavLink>}
      </nav>
      <span className="header-spacer" />
      <div className="header-actions">
        <button
          type="button"
          className="icon-btn"
          aria-label={`主题：${THEME_LABEL[prefs.theme]}（点击切换）`}
          title={`主题：${THEME_LABEL[prefs.theme]}`}
          onClick={() => setPrefs({ theme: nextTheme(prefs.theme) })}
        >
          <ThemeIcon />
        </button>
        {user && !user.restricted && (
          <Link to="/notifications" className="icon-btn" aria-label={`通知${unread ? `（${unread} 条未读）` : ''}`}>
            <BellIcon />
            {unread > 0 && <span className="dot-count">{unread > 99 ? '99+' : unread}</span>}
          </Link>
        )}
        {user ? (
          <div className="menu" ref={menuRef}>
            <button type="button" className="icon-btn" aria-label="用户菜单" aria-expanded={menuOpen} onClick={() => setMenuOpen((v) => !v)}>
              <UserIcon />
            </button>
            {menuOpen && (
              <div className="menu-pop" role="menu">
                <div className="menu-head">{user.displayName || user.email}<br />{user.email} · {user.role === 'admin' ? '管理员' : '成员'}</div>
                <hr />
                {(outboxDriver || user.restricted) && <Link to="/me/outbox" role="menuitem">我的邮件{outboxDriver ? '（本地 outbox）' : ''}</Link>}
                {!user.restricted && <Link to="/notifications" role="menuitem">通知与设置</Link>}
                {auth.isAdmin && <Link to="/admin" role="menuitem">管理后台</Link>}
                <button type="button" role="menuitemcheckbox" aria-checked={prefs.showBadges} onClick={() => setPrefs({ showBadges: !prefs.showBadges })}>
                  {prefs.showBadges ? '☑' : '☐'} 显示架构徽章
                </button>
                {!auth.isAdmin && (
                  <button type="button" role="menuitemcheckbox" aria-checked={prefs.traceEnabled} onClick={() => setPrefs({ traceEnabled: !prefs.traceEnabled })}>
                    {prefs.traceEnabled ? '☑' : '☐'} 路径追踪抽屉
                  </button>
                )}
                <hr />
                <button type="button" role="menuitem" onClick={() => void logout()}>退出登录</button>
              </div>
            )}
          </div>
        ) : (
          <>
            <Link to="/login" className="btn btn-sm">登录</Link>
            <Link to="/register" className="btn btn-sm btn-primary hide-narrow">注册</Link>
          </>
        )}
      </div>
    </header>
  );
}

function Banners() {
  const caps = useCaps();
  const auth = useAuth();
  const [expanded, setExpanded] = useState(false);
  const { errors, warnings, overridden } = caps.validation;
  const shownWarnings = expanded ? warnings : warnings.slice(0, 2);
  const dbDown = caps.modules.database?.status === 'error';
  const mock = (globalThis as { __CLOUDALBUM_MOCK__?: string }).__CLOUDALBUM_MOCK__;
  return (
    <>
      {mock && (
        <div className="banner banner-info" role="status">
          <strong>开发用模拟后端（{mock}）</strong>
          <span>未实现或不可达的接口由 frontend/src/mock 在浏览器内模拟；URL 加 ?mock=off 关闭。</span>
        </div>
      )}
      {overridden.map((f) => (
        <div key={`o-${f.rule}`} className="banner banner-error" role="alert">
          <strong>不安全实验模式</strong>
          <span className="mono">{f.rule}</span>
          <span>{f.message}（已被 CLOUDALBUM_ALLOW_UNSAFE 降级为警告）</span>
        </div>
      ))}
      {errors.map((f) => (
        <div key={`e-${f.rule}`} className="banner banner-error" role="alert">
          <strong>配置错误</strong><span className="mono">{f.rule}</span><span>{f.message}</span>
        </div>
      ))}
      {dbDown && (
        <div className="banner banner-error" role="alert"><strong>数据库不可用</strong><span>可能正在故障转移，应用会自动重连。</span></div>
      )}
      {shownWarnings.map((f) => (
        <div key={`w-${f.rule}-${f.message}`} className="banner banner-warn">
          <strong>提示</strong><span className="mono">{f.rule}</span><span>{f.message}</span>
          {f.fix && auth.isAdmin && <code className="wrap-any">{f.fix}</code>}
        </div>
      ))}
      {warnings.length > 2 && (
        <div className="banner banner-warn">
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setExpanded((v) => !v)}>
            {expanded ? '收起' : `还有 ${warnings.length - 2} 条提示`}
          </button>
        </div>
      )}
      {auth.user?.restricted && (
        <div className="banner banner-info">
          <strong>邮箱尚未验证</strong>
          <span>当前是受限会话：只能查看发给你的邮件。</span>
          <Link to="/me/outbox">打开我的邮件完成验证</Link>
        </div>
      )}
    </>
  );
}

function FooterStatus() {
  const caps = useCaps();
  const { latestPath } = useTraces();
  const auth = useAuth();
  const inst = latestPath?.inst || caps.app.instance.id;
  const az = latestPath?.az || caps.app.instance.az;
  const iam = caps.modules.iam;
  return (
    <footer className="footer" aria-label="运行状态">
      <span title="最近一个请求的 X-CloudAlbum-Path entry 段">入口：{entryChainLabel(latestPath?.entry)}</span>
      <span className="sep">·</span>
      <span className="mono" title="实例 ID">{shortId(inst, 10)}</span>
      {az && (<><span className="sep">·</span><span className="mono">{az}</span></>)}
      <span className="sep">·</span>
      <span>{caps.app.deployMode === 'asg' ? 'ASG（每个请求命中的实例见左侧）' : 'single'}</span>
      <span className="sep">·</span>
      <span>档位 <span className="mono">{caps.app.profile}</span></span>
      {iam && iam.status !== 'off' && (<><span className="sep">·</span><span>凭证：{iam.driver === 'keys' ? '长期密钥（不安全）' : '实例角色'}</span></>)}
      <span className="header-spacer" />
      <ModuleBadge
        module="ec2"
        variant="footer"
        plain={!auth.user}
        vars={{
          instanceId: shortId(caps.app.instance.id, 10),
          instanceType: caps.app.instance.type,
          az: caps.app.instance.az,
          deployMode: caps.app.deployMode,
        }}
      />
      <span className="subtle">v{caps.app.version}</span>
    </footer>
  );
}
