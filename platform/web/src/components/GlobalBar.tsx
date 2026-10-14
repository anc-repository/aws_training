/**
 * 全局顶栏 GlobalBar（08 §3.1、§3.2）：平台标志与“非 AWS 官方”、一级导航（卡片目录 / 学习路径 / 我的学习 / 我的实验）、
 * 当前会话胶囊、学习进度入口、账号与区域；< 1024px 一级导航收进 ≡ 抽屉。
 * 实际高度由 ResizeObserver 写入 --topbar-h（吸顶元素的偏移都用它）。
 * 学习进度入口 ProgressDisclosure 的内容（当前路径进度、recommendNext）是 `pages/labs/components/ProgressPanel`，展开时按需加载。
 */
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useGlobalStatus } from '../app/globalStatus';
import { useLocaleSync } from '../app/localeSync';
import { msg } from '../i18n';
import { LanguageSwitcher } from '../i18n/LanguageSwitcher';
import { BrandMark, Disclosure, Drawer, Icon, Skeleton } from '../ui';
import { AccountMenu } from './AccountMenu';
import { SessionPill } from './SessionPill';

const ProgressPanel = lazy(() => import('../pages/labs/components/ProgressPanel'));

interface NavItem {
  to: string;
  label: string;
  /** 这些路径前缀下 aria-current="page"。 */
  match: string[];
}

export function navItems(currentTrackId: string): NavItem[] {
  const n = msg.nav;
  return [
    { to: '/labs', label: n.catalog, match: ['/labs'] },
    { to: `/tracks/${currentTrackId}`, label: n.track, match: ['/tracks'] },
    { to: '/learning', label: n.learning, match: ['/learning', '/certificates'] },
    { to: '/sessions', label: n.sessions, match: ['/sessions', '/resources/manual'] },
  ];
}

function isActive(pathname: string, item: NavItem): boolean {
  return item.match.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

function NavLinks({ items, onNavigate }: { items: NavItem[]; onNavigate?: () => void }) {
  const { pathname } = useLocation();
  return (
    <>
      {items.map((it) => (
        <Link key={it.to} to={it.to} aria-current={isActive(pathname, it) ? 'page' : undefined} onClick={onNavigate}>
          {it.label}
        </Link>
      ))}
    </>
  );
}

function ProgressDisclosure() {
  return (
    <Disclosure
      className="hide-md"
      label={
        <>
          {msg.frame.bar.progress} <Icon name="chev" />
        </>
      }
      buttonClassName="btn sm"
    >
      {(close) => (
        <>
          <Suspense fallback={<Skeleton lines={2} />}>
            <ProgressPanel onNavigate={close} />
          </Suspense>
          <div className="row">
            <Link className="btn sm" to="/learning" onClick={close}>
              {msg.frame.bar.learning}
            </Link>
            <Link className="btn sm" to="/certificates" onClick={close}>
              {msg.frame.bar.certificates}
            </Link>
          </div>
        </>
      )}
    </Disclosure>
  );
}

export function GlobalBar() {
  const { me } = useGlobalStatus();
  const onLocale = useLocaleSync();
  const items = navItems(me?.currentTrackId ?? 'saa-main');
  const [drawer, setDrawer] = useState(false);
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => document.documentElement.style.setProperty('--topbar-h', `${el.offsetHeight}px`));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const n = msg.nav;
  return (
    <header className="gbar" ref={ref}>
      <Link className="brand" to="/labs" title={msg.app.fullName}>
        <BrandMark />
        <span className="bname">{msg.app.name}</span>
        <span className="unofficial">{msg.app.unofficial}</span>
      </Link>
      <nav className="gnav" aria-label={n.label}>
        <NavLinks items={items} />
      </nav>
      <div className="right">
        <SessionPill />
        <ProgressDisclosure />
        <LanguageSwitcher onChanged={onLocale} />
        <AccountMenu />
        <button type="button" className="btn sm icon menu-btn" aria-label={n.openMenu} aria-expanded={drawer} onClick={() => setDrawer(true)}>
          <Icon name="menu" />
        </button>
      </div>
      <Drawer open={drawer} onClose={() => setDrawer(false)} title={n.label}>
        <nav aria-label={n.label} className="stack-4 gnav-drawer">
          <NavLinks items={items} onNavigate={() => setDrawer(false)} />
        </nav>
      </Drawer>
    </header>
  );
}
