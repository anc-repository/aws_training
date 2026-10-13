/**
 * P12 平台设置、升级与卸载 `/settings/:tab`（08 §4 P12；01 §4.7、§4.8、§5.4；02 §10.5）。
 * 页签：profile、platform、guardrails、workspace、members、content、audit、upgrade、uninstall。
 * 学员可进入全部页签；助教只有 profile 与 audit；观察者只有 profile（§2.3）。会改变 URL 的页签用 <nav> + 链接 + aria-current（§8.2）。
 */
import { Link, useParams } from 'react-router-dom';
import { useAuth } from '../../app/context';
import type { Role } from '../../auth/jwt';
import { NotFoundPage, RoleDeniedPage } from '../../components/ErrorPages';
import { PageStub } from '../../components/PageStub';

export const SETTINGS_TABS = ['profile', 'platform', 'guardrails', 'workspace', 'members', 'content', 'audit', 'upgrade', 'uninstall'] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];

export const SETTINGS_TAB_LABEL: Record<SettingsTab, string> = {
  profile: '个人资料',
  platform: '平台',
  guardrails: '护栏',
  workspace: '工作台',
  members: '成员',
  content: '内容',
  audit: '审计',
  upgrade: '升级',
  uninstall: '卸载',
};

export function settingsTabsFor(role: Role | null): SettingsTab[] {
  if (role === 'L') return [...SETTINGS_TABS];
  if (role === 'A') return ['profile', 'audit'];
  if (role === 'O') return ['profile'];
  return [];
}

export default function SettingsPage() {
  const { tab = 'profile' } = useParams();
  const { principal } = useAuth();
  const role = principal?.role ?? null;
  if (!(SETTINGS_TABS as readonly string[]).includes(tab)) return <NotFoundPage />;
  const tabs = settingsTabsFor(role);
  if (!tabs.includes(tab as SettingsTab)) return <RoleDeniedPage role={role} />;
  return (
    <PageStub screen="P12" title="设置" spec="08 §4 P12；01 §4.7、§4.8、§5.4；02 §10.5">
      <div className="sidenav-layout">
        <nav className="sidenav" aria-label="设置">
          {tabs.map((t) => (
            <Link key={t} to={`/settings/${t}`} aria-current={t === tab ? 'page' : undefined}>
              {SETTINGS_TAB_LABEL[t]}
            </Link>
          ))}
        </nav>
        <section aria-label={SETTINGS_TAB_LABEL[tab as SettingsTab]}>
          <h2>{SETTINGS_TAB_LABEL[tab as SettingsTab]}</h2>
        </section>
      </div>
    </PageStub>
  );
}
