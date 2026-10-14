/**
 * 账号与区域 AccountMenu（08 §3.5）。
 * - 区域与灾备区域取 GET /platform；区域不可在界面中切换；
 * - 账号 ID 全站统一打码为 `••••后 4 位`；只有学员有“显示”按钮，点击后显示完整值 10 秒（04 §4.4 规则 4）；
 *   值已被服务端打码时不显示“显示”（§9.2 #34）；没有账号 ID 时写“账号 ID 将在第一次实验时显示”；
 * - 浮层打开时焦点落在浮层容器本身（role="group"、aria-label="账号与区域"），不落在“显示”上；
 * - 主题（跟随系统 / 亮 / 暗）、快捷键与图例、个人资料、平台设置（仅学员）、退出。
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth, useServices } from '../app/context';
import { useGlobalStatus } from '../app/globalStatus';
import { getThemePref, setThemePref, type ThemePref } from '../app/theme';
import { msg, t } from '../i18n';
import { isMaskedAccountId, maskAccountId } from '../lib/redact';
import { Disclosure, Icon } from '../ui';

export function AccountMenu() {
  const { auth } = useServices();
  const { principal } = useAuth();
  const { platform, me } = useGlobalStatus();
  const [theme, setTheme] = useState<ThemePref>(getThemePref);
  const [reveal, setReveal] = useState(false);
  useEffect(() => {
    if (!reveal) return undefined;
    const timer = setTimeout(() => setReveal(false), 10_000);
    return () => clearTimeout(timer);
  }, [reveal]);

  const a = msg.account;
  const role = principal?.role ?? null;
  const roleText = role ? msg.roles[role] : '';
  const name = me?.displayName ?? principal?.username ?? '';
  const region = platform.data?.region ?? '—';
  const accountId = platform.data?.accountId ?? null;
  const masked = accountId ? (isMaskedAccountId(accountId) ? accountId : maskAccountId(accountId)) : null;
  const last4 = masked ? masked.slice(-4) : '—';
  const canReveal = role === 'L' && !!accountId && !isMaskedAccountId(accountId);

  return (
    <Disclosure
      ariaLabel={t(a.menuLabel, { region, last4, name, role: roleText })}
      label={
        <>
          {/* 区域与账号（打码）在 1440px 以下只放在展开的菜单里：顶栏在各语言下都保持一行（09 §1） */}
          <span className="mono hide-sm hide-lg">{region}</span>
          <span className="hide-sm hide-lg faint">·</span>
          <span className="mono hide-sm hide-lg">{masked ?? '••••'}</span>
          <span className="hide-sm hide-lg faint">·</span>
          <Icon name="user" />
          <span className="hide-sm">{name}</span>
          <Icon name="chev" />
        </>
      }
      focusContainer
      panelRole="group"
      panelLabel={a.menu}
    >
      {(close) => (
        <>
          <div>
            <b>{name}</b>（{roleText}）{principal?.email ? <span className="muted"> · {principal.email}</span> : null}
          </div>
          <div className="small">
            {a.account}{' '}
            {masked ? (
              <span className="mono" data-account-id="">
                {reveal && canReveal ? accountId : masked}
              </span>
            ) : (
              <span className="muted">{a.accountLater}</span>
            )}{' '}
            {canReveal ? (
              <button type="button" className="linkbtn small" aria-label={a.revealLabel} onClick={() => setReveal(true)}>
                {a.reveal}
              </button>
            ) : null}{' '}
            · {a.region} <span className="mono">{region}</span>
          </div>
          <div className="small muted">
            {a.drRegion} <span className="mono">{platform.data?.drRegion ?? '—'}</span> · {msg.app.name} {platform.data?.version ?? ''} · {a.regionFixed}
          </div>
          <fieldset className="small" data-theme-picker="">
            <legend className="flabel">{a.theme}</legend>
            <div className="radio-row">
              {(
                [
                  ['system', a.themeSystem],
                  ['light', a.themeLight],
                  ['dark', a.themeDark],
                ] as const
              ).map(([v, label]) => (
                <label key={v}>
                  <input
                    type="radio"
                    name="atl-theme"
                    value={v}
                    checked={theme === v}
                    onChange={() => {
                      setTheme(v);
                      setThemePref(v);
                    }}
                  />
                  {label}
                </label>
              ))}
            </div>
          </fieldset>
          <Link className="mi" to="/settings/profile" onClick={close}>
            {a.profile}
          </Link>
          {role === 'L' ? (
            <Link className="mi" to="/settings/platform" onClick={close}>
              {a.settings}
            </Link>
          ) : null}
          <button type="button" className="mi" onClick={() => void auth.signOut()}>
            {a.signOut}
          </button>
        </>
      )}
    </Disclosure>
  );
}
