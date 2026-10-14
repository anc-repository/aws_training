/**
 * P12 平台设置、升级与卸载 `/settings/:tab`（08 §4 P12；01 §4.7、§4.8、§5.4；02 §10.5）。
 * - 左侧页签导航（`<nav>` + 链接 + aria-current，会改变 URL）；窄屏改为下拉；
 * - 学员全部页签；助教只有 profile 与 audit，观察者只有 profile；直接访问其他页签显示“角色不足”（P13），未知页签回到 profile；
 * - 卸载中：除 uninstall、profile、audit 外的页签只读；读取失败显示区块级错误，其他页签照常可用。
 * 本文件实现 profile、platform、guardrails、content、upgrade；workspace、members、audit、uninstall 在 AdminTabs.tsx。
 */
import { useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { isApiError } from '../../api/errors';
import { useAuth, useServices, useSessionSync } from '../../app/context';
import { useGlobalStatus } from '../../app/globalStatus';
import { pillTarget } from '../../app/sessionRouting';
import { getThemePref, setThemePref, type ThemePref } from '../../app/theme';
import { RoleDeniedPage } from '../../components/ErrorPages';
import { msg, t } from '../../i18n';
import { formatDate } from '../../lib/format';
import { lsGet, lsSet, STORAGE_KEYS } from '../../lib/storage';
import { BUDGET_META, Button, CommandBlock, Dialog, ErrorPanel, Field, SESSION_STATE_META, Shape, Skeleton } from '../../ui';
import '../labs/catalog.css';
import { useResource } from '../labs/data';
import { NOTIFY_PREF_KEY } from '../labs/keys';
import type { CatalogRef } from '../labs/types';
import { verdictOf, type PreflightItem } from '../setup/preflight';
import { AuditTab, MembersTab, UninstallTab, WorkspaceTab } from './AdminTabs';
import { allowedTabs, isSettingsTab, readOnlyTab, type SettingsTab } from './model';
import { ST } from './strings';

/** 终端偏好：与工作台共用的 localStorage 键与结构（workspace 的 loadTermPrefs）。 */
const TERM_PREFS_KEY = 'atl.ws.terminal.v1';
type Leader = 'ctrl-period' | 'ctrl-backquote' | 'ctrl-shift-period';
const LEADER_TEXT: Readonly<Record<Leader, string>> = { 'ctrl-period': 'Ctrl+.', 'ctrl-backquote': 'Ctrl+`', 'ctrl-shift-period': 'Ctrl+Shift+.' };

function useMaintenance() {
  const { api } = useServices();
  const status = useGlobalStatus();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = async (on: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await api.call('setMaintenance', { body: { on } });
      status.retryPlatform();
    } catch (e) {
      setError(isApiError(e) ? (e.status === 409 ? ST.guardrails.activeBlocks : (e.detail ?? e.title)) : String(e));
    } finally {
      setBusy(false);
    }
  };
  return { on: !!status.platform.data?.maintenance, busy, error, set };
}

// ---------------------------------------------------------------------------------------------------------------
// profile

function ProfileTab() {
  const { api } = useServices();
  const status = useGlobalStatus();
  const me = status.me;
  const [name, setName] = useState<string | null>(null);
  const [cert, setCert] = useState<string | null>(null);
  const [theme, setTheme] = useState<ThemePref>(() => getThemePref());
  const [shortcuts, setShortcuts] = useState<boolean>(() => lsGet<boolean>(STORAGE_KEYS.shortcuts, true));
  const [term, setTerm] = useState(() => {
    const p = lsGet<{ fontSize?: number; screenReader?: boolean; leader?: Leader }>(TERM_PREFS_KEY, {});
    return {
      fontSize: typeof p.fontSize === 'number' && p.fontSize >= 12 && p.fontSize <= 18 ? p.fontSize : 13,
      screenReader: p.screenReader === true,
      leader: (p.leader && p.leader in LEADER_TEXT ? p.leader : 'ctrl-period') as Leader,
    };
  });
  const [notify, setNotify] = useState<boolean>(() => lsGet<boolean>(NOTIFY_PREF_KEY, false));
  const [denied, setDenied] = useState(false);
  const [save, setSave] = useState<{ busy: boolean; done: boolean; error: unknown }>({ busy: false, done: false, error: null });
  const displayName = name ?? me?.displayName ?? '';
  const certName = cert ?? me?.certName ?? '';
  const setTermPrefs = (patch: Partial<typeof term>) => {
    const n = { ...term, ...patch };
    setTerm(n);
    lsSet(TERM_PREFS_KEY, n);
  };
  const submit = async () => {
    if (!displayName.trim()) return;
    setSave({ busy: true, done: false, error: null });
    try {
      await api.call('patchMe', { body: { displayName: displayName.trim(), certName: certName.trim() || null } });
      await status.refreshMe();
      setSave({ busy: false, done: true, error: null });
    } catch (e) {
      setSave({ busy: false, done: false, error: e });
    }
  };
  return (
    <div className="stack maxw-560" data-tab="profile">
      <Field label={ST.profile.displayName} error={displayName.trim() ? null : ST.profile.nameRequired}>
        <input className="input" value={displayName} maxLength={64} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label={ST.profile.certName}>
        <input className="input" value={certName} maxLength={64} onChange={(e) => setCert(e.target.value)} />
      </Field>
      <div className="row">
        <Button variant="primary" busy={save.busy} busyText={ST.saving} disabledReason={displayName.trim() ? null : ST.profile.nameRequired} onClick={() => void submit()}>
          {ST.save}
        </Button>
        {save.done ? (
          <span className="small st pass" role="status">
            <Shape name="check" />
            <span className="t">{ST.saved}</span>
          </span>
        ) : null}
      </div>
      {save.error ? <ErrorPanel error={isApiError(save.error) ? save.error : { code: 'INTERNAL' }} onRetry={() => void submit()} /> : null}
      <hr className="rule" />
      <p className="small muted">{ST.profile.localNote}</p>
      <fieldset className="plain stack-4">
        <legend className="flabel">{ST.profile.theme}</legend>
        <div className="radio-row">
          {(
            [
              ['system', ST.profile.themeSystem],
              ['light', ST.profile.themeLight],
              ['dark', ST.profile.themeDark],
            ] as const
          ).map(([v, label]) => (
            <label key={v}>
              <input
                type="radio"
                name="settings-theme"
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
      <label className="chk">
        <input
          type="checkbox"
          checked={shortcuts}
          onChange={(e) => {
            setShortcuts(e.target.checked);
            lsSet(STORAGE_KEYS.shortcuts, e.target.checked);
          }}
        />
        <span>{ST.profile.shortcuts}</span>
      </label>
      <Field label={ST.profile.leader}>
        <select className="input" value={term.leader} onChange={(e) => setTermPrefs({ leader: e.target.value as Leader })}>
          {(Object.keys(LEADER_TEXT) as Leader[]).map((k) => (
            <option key={k} value={k}>
              {LEADER_TEXT[k]}
            </option>
          ))}
        </select>
      </Field>
      <Field label={ST.profile.fontSize}>
        <select className="input" value={term.fontSize} onChange={(e) => setTermPrefs({ fontSize: Number(e.target.value) })}>
          {[12, 13, 14, 16, 18].map((n) => (
            <option key={n} value={n}>
              {n}px
            </option>
          ))}
        </select>
      </Field>
      <label className="chk">
        <input type="checkbox" checked={term.screenReader} onChange={(e) => setTermPrefs({ screenReader: e.target.checked })} />
        <span>{ST.profile.screenReader}</span>
      </label>
      <label className="chk">
        <input
          type="checkbox"
          checked={notify}
          onChange={(e) => {
            const on = e.target.checked;
            setNotify(on);
            lsSet(NOTIFY_PREF_KEY, on);
            setDenied(false);
            if (on && typeof Notification !== 'undefined') {
              if (Notification.permission === 'denied') setDenied(true);
              else if (Notification.permission === 'default') void Notification.requestPermission().then((p) => setDenied(p === 'denied')).catch(() => undefined);
            }
          }}
        />
        <span>{ST.profile.notify}</span>
      </label>
      {denied ? <p className="small st drift">{ST.profile.notifyDenied}</p> : null}
      <div>
        <Link className="btn ghost" to="/setup">
          {ST.profile.revisit}
        </Link>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// platform

function PlatformTab() {
  const status = useGlobalStatus();
  const p = status.platform.data;
  if (status.platform.status === 'failed') return <ErrorPanel error={status.platform.error ?? { code: 'INTERNAL' }} onRetry={status.retryPlatform} />;
  if (!p) return <Skeleton lines={6} />;
  const f = (p.features ?? {}) as { terminalRecording?: string; platformTrail?: unknown; accessAnalyzer?: string | null };
  const items = ((p.preflight?.items ?? []) as PreflightItem[]).map(verdictOf);
  const count = (v: string) => items.filter((x) => x === v).length;
  const dev = /dev/i.test(p.version);
  return (
    <div className="stack-16" data-tab="platform">
      <dl className="kv">
        <dt>{ST.platform.version}</dt>
        <dd>
          {p.version}
          {dev ? <span className="tag">{ST.platform.dev}</span> : null}
        </dd>
        <dt>{ST.platform.catalog}</dt>
        <dd className="mono">{p.catalogVersion ?? '—'}</dd>
        <dt>{ST.platform.region}</dt>
        <dd className="mono">{p.region}</dd>
        <dt>{ST.platform.dr}</dt>
        <dd className="mono">{p.drRegion || ST.platform.drNone}</dd>
        <dt>{ST.platform.installation}</dt>
        <dd className="mono wrap-any">{p.installationId ?? '—'}</dd>
        <dt>{ST.platform.url}</dt>
        <dd className="mono wrap-any">{p.platformUrl ?? '—'}</dd>
        <dt>{ST.platform.features}</dt>
        <dd>
          {t(ST.platform.featureText, {
            rec: f.terminalRecording && f.terminalRecording !== 'off' ? ST.platform.on : ST.platform.off,
            trail: f.platformTrail ? ST.platform.on : ST.platform.off,
            aa: f.accessAnalyzer ?? '—',
          })}
        </dd>
      </dl>
      <p className="small muted">{ST.platform.regionNote}</p>
      <section className="sec" aria-labelledby="pf-h">
        <h2 id="pf-h">{ST.platform.preflight}</h2>
        {p.preflight?.checkedAt ? (
          <p className="small">
            {t(ST.platform.preflightCounts, { fix: count('fix'), warn: count('warn'), pass: count('pass'), unknown: count('unknown') })}{' '}
            <Link to="/setup?step=2">{ST.platform.details}</Link>
          </p>
        ) : (
          <p className="small muted">{ST.platform.preflightNone}</p>
        )}
        <div>
          <Link className="btn ghost" to="/setup">
            {ST.profile.revisit}
          </Link>
        </div>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// guardrails

function GuardrailsTab({ readOnly }: { readOnly: boolean }) {
  const status = useGlobalStatus();
  const maint = useMaintenance();
  const p = status.platform.data;
  const g = status.guardrails;
  const lim = (g?.limits ?? p?.limits ?? {}) as Record<string, unknown> & { maxSessionMinutes?: number; maxKeepHours?: number; envMaxAgeDays?: number; readyIdleMinutes?: number; extension?: { minutes?: number; maxCount?: number } };
  const known: [string, string][] = [
    [ST.guardrails.maxSession, lim.maxSessionMinutes != null ? t(ST.guardrails.minutes, { n: lim.maxSessionMinutes }) : '—'],
    [ST.guardrails.extension, lim.extension?.maxCount != null ? t(ST.guardrails.extensionValue, { n: lim.extension.maxCount, m: lim.extension.minutes ?? '—' }) : '—'],
    [ST.guardrails.keep, lim.maxKeepHours != null ? t(ST.guardrails.hours, { n: lim.maxKeepHours }) : '—'],
    [ST.guardrails.envAge, lim.envMaxAgeDays != null ? t(ST.guardrails.days, { n: lim.envMaxAgeDays }) : '—'],
    [ST.guardrails.readyIdle, lim.readyIdleMinutes != null ? t(ST.guardrails.minutes, { n: lim.readyIdleMinutes }) : '—'],
    [ST.guardrails.instanceTypes, (p?.allowedInstanceTypes ?? []).join(' · ') || '—'],
  ];
  const skip = new Set(['maxSessionMinutes', 'maxKeepHours', 'envMaxAgeDays', 'readyIdleMinutes', 'extension']);
  const extra = Object.entries(lim).filter(([k, v]) => !skip.has(k) && (typeof v === 'number' || typeof v === 'string'));
  const budget = g?.budget ?? null;
  return (
    <div className="stack-16" data-tab="guardrails">
      <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th scope="col">{ST.guardrails.limits}</th>
              <th scope="col">{ST.guardrails.value}</th>
            </tr>
          </thead>
          <tbody>
            {known.map(([k, v]) => (
              <tr key={k}>
                <td>{k}</td>
                <td className="mono">{v}</td>
              </tr>
            ))}
            {extra.map(([k, v]) => (
              <tr key={k}>
                <td className="mono">{k}</td>
                <td className="mono">{String(v)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="box stack-4" data-budget={budget?.state ?? 'unset'}>
        <b>{ST.guardrails.budget}</b>
        {budget && budget.amount ? (
          <div className="small">
            {t(ST.guardrails.enforcement, { e: budget.enforcement })}
            <span className={`st ${BUDGET_META[budget.state].tone}`}>
              <Shape name={BUDGET_META[budget.state].shape} />
              <span className="t">{BUDGET_META[budget.state].text}</span>
            </span>
          </div>
        ) : (
          <div className="small muted">{ST.guardrails.budgetUnset}</div>
        )}
      </div>
      <div className="box row between" data-maintenance={maint.on ? 'on' : 'off'}>
        <div className="stack-4">
          <b>{ST.guardrails.maintenance}</b>
          <span className="small muted">{ST.guardrails.maintenanceHint}</span>
          {maint.error ? (
            <span className="small st fail" role="alert">
              {maint.error}
            </span>
          ) : null}
        </div>
        <Button
          variant={maint.on ? 'primary' : 'default'}
          busy={maint.busy}
          busyText={ST.guardrails.busy}
          disabledReason={readOnly ? ST.readonly : null}
          aria-pressed={maint.on}
          onClick={() => void maint.set(!maint.on)}
        >
          {maint.on ? ST.guardrails.exit : ST.guardrails.enter}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// content

function ContentTab({ readOnly }: { readOnly: boolean }) {
  const { api, clock } = useServices();
  const cat = useResource<CatalogRef>('catalog-content', () => api.get<CatalogRef>('getCatalog'));
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (cat.error && !cat.data) return <ErrorPanel error={cat.error} onRetry={cat.reload} />;
  if (!cat.data) return <Skeleton lines={4} />;
  const c = cat.data;
  const defective = !!c.defective;
  const mark = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.call('markReleaseDefective', { params: { catalogVersion: c.catalogVersion }, body: reason.trim() ? { reason: reason.trim() } : {} });
      setOpen(false);
      api.invalidate();
      cat.reload();
    } catch (e) {
      setError(isApiError(e) ? (e.detail ?? e.title) : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="stack-16" data-tab="content">
      <dl className="kv">
        <dt>{ST.content.version}</dt>
        <dd className="mono">{c.catalogVersion}</dd>
        <dt>{ST.content.publishedAt}</dt>
        <dd>{c.publishedAt ? formatDate(c.publishedAt, clock.now()) : '—'}</dd>
        <dt>{ST.content.digest}</dt>
        <dd className="mono wrap-any">{c.contentDigest ?? '—'}</dd>
        <dt>{ST.content.defective}</dt>
        <dd>
          {defective ? (
            <span className="st fail">
              <Shape name="xbox" />
              <span className="t">{ST.content.defectiveYes}</span>
            </span>
          ) : (
            ST.content.defectiveNo
          )}
        </dd>
      </dl>
      {!defective ? (
        <div>
          <Button variant="danger" disabledReason={readOnly ? ST.readonly : null} onClick={() => setOpen(true)}>
            {ST.content.mark}
          </Button>
        </div>
      ) : null}
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={ST.content.markTitle}
        size="narrow"
        alert
        initialFocus="[data-cancel]"
        footer={
          <>
            <Button onClick={() => setOpen(false)} data-cancel="">
              {msg.app.cancel}
            </Button>
            <Button variant="danger-solid" busy={busy} busyText={ST.content.busy} onClick={() => void mark()}>
              {ST.content.confirm}
            </Button>
          </>
        }
      >
        <p>{ST.content.markBody}</p>
        <Field label={ST.content.reason}>
          <textarea className="input" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        {error ? (
          <p className="note red" role="alert">
            {error}
          </p>
        ) : null}
      </Dialog>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// upgrade

function UpgradeTab({ readOnly }: { readOnly: boolean }) {
  const status = useGlobalStatus();
  const { current } = useSessionSync();
  const maint = useMaintenance();
  const p = status.platform.data;
  if (status.platform.status === 'failed') return <ErrorPanel error={status.platform.error ?? { code: 'INTERNAL' }} onRetry={status.retryPlatform} title={ST.upgrade.failed} />;
  if (!p) return <Skeleton lines={5} />;
  const dev = /dev/i.test(p.version);
  const latest = p.update?.latest ?? null;
  const hasUpdate = !!latest && latest !== p.version;
  const active = current && !['ENDED', 'FAILED'].includes(current.state) ? current : null;
  const target = latest ?? 'vX.Y.Z';
  const changeSet = `aws cloudformation create-change-set --stack-name atl --change-set-name atl-${target.replace(/[^A-Za-z0-9-]/g, '-')} \\\n  --template-url ${p.update?.templateUrl ?? ST.upgrade.templatePlaceholder} --capabilities CAPABILITY_NAMED_IAM \\\n  --parameters ParameterKey=ReleaseVersion,ParameterValue=${target} ${msg.frame.otherParams}`;
  return (
    <div className="stack-16" data-tab="upgrade">
      <p>
        {t(ST.upgrade.current, { v: p.version })} ·{' '}
        {dev ? (
          ST.upgrade.devVersion
        ) : hasUpdate ? (
          <>
            <b>{t(ST.upgrade.latest, { v: latest })}</b>
            {p.update?.notesUrl ? (
              <>
                （
                <a href={p.update.notesUrl} target="_blank" rel="noopener noreferrer">
                  {ST.upgrade.notes} ↗<span className="sr">{msg.app.newTab}</span>
                </a>
                ）
              </>
            ) : null}
          </>
        ) : (
          ST.upgrade.upToDate
        )}
      </p>
      <div className="row">
        <span>{ST.upgrade.prereq}</span>
        {active ? (
          <>
            <span className="st fail">
              <Shape name="xbox" />
              <span className="t">{t(ST.upgrade.prereqActive, { labId: active.labId, state: SESSION_STATE_META[active.state].text })}</span>
            </span>
            {pillTarget(active) ? <Link to={pillTarget(active)!}>{ST.upgrade.toSession}</Link> : null}
          </>
        ) : (
          <span className="st pass">
            <Shape name="check" />
            <span className="t">{ST.upgrade.prereqOk}</span>
          </span>
        )}
      </div>
      <ol className="stack-8">
        <li>
          {ST.upgrade.step1}{' '}
          <Button size="sm" busy={maint.busy} busyText={ST.guardrails.busy} disabledReason={readOnly ? ST.readonly : null} onClick={() => void maint.set(!maint.on)}>
            {maint.on ? ST.guardrails.exit : ST.guardrails.enter}
          </Button>
          {maint.on ? <span className="small muted"> {ST.upgrade.step1On}</span> : null}
          {maint.error ? (
            <span className="small st fail" role="alert">
              {' '}
              {maint.error}
            </span>
          ) : null}
        </li>
        <li className="stack-8">
          <span>
            {ST.upgrade.step2}{' '}
            <a href={`https://console.aws.amazon.com/cloudformation/home?region=${encodeURIComponent(p.region)}`} target="_blank" rel="noopener noreferrer">
              {ST.upgrade.openCfn} ↗<span className="sr">{msg.app.newTab}</span>
            </a>
          </span>
          <CommandBlock text={changeSet} runsOn="local" copyOnly />
        </li>
        <li>{ST.upgrade.step3}</li>
        <li>{ST.upgrade.step4}</li>
      </ol>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------

export default function SettingsPage() {
  const { tab: raw } = useParams();
  const navigate = useNavigate();
  const auth = useAuth();
  const role = auth.principal?.role ?? null;
  const status = useGlobalStatus();
  if (!isSettingsTab(raw)) return <Navigate to="/settings/profile" replace />;
  const tab: SettingsTab = raw;
  const allowed = allowedTabs(role);
  if (!allowed.includes(tab)) return <RoleDeniedPage role={role} />;
  const uninstalling = status.platform.data?.mode === 'UNINSTALLING';
  const ro = readOnlyTab(tab, uninstalling);
  const title = ST.tabs[tab];
  return (
    <div className="stack-16" data-screen="P12" data-tab={tab}>
      <div className="ph">
        <h1 tabIndex={-1}>{ST.title}</h1>
      </div>
      <div className="sidenav-layout">
        <div>
          <nav className="sidenav" aria-label={ST.navLabel}>
            {allowed.map((k) => (
              <Link key={k} to={`/settings/${k}`} aria-current={k === tab ? 'page' : undefined}>
                {ST.tabs[k]}
              </Link>
            ))}
          </nav>
          <select className="input sidenav-select" aria-label={ST.selectLabel} value={tab} onChange={(e) => navigate(`/settings/${e.target.value}`)}>
            {allowed.map((k) => (
              <option key={k} value={k}>
                {ST.tabs[k]}
              </option>
            ))}
          </select>
        </div>
        <section className="stack-16" aria-labelledby="settings-tab-h">
          <h2 id="settings-tab-h">{title}</h2>
          {ro ? <div className="note">{ST.readonly}</div> : null}
          {tab === 'profile' ? <ProfileTab /> : null}
          {tab === 'platform' ? <PlatformTab /> : null}
          {tab === 'guardrails' ? <GuardrailsTab readOnly={ro} /> : null}
          {tab === 'workspace' ? <WorkspaceTab readOnly={ro} /> : null}
          {tab === 'members' ? <MembersTab readOnly={ro} /> : null}
          {tab === 'content' ? <ContentTab readOnly={ro} /> : null}
          {tab === 'audit' ? <AuditTab /> : null}
          {tab === 'upgrade' ? <UpgradeTab readOnly={ro} /> : null}
          {tab === 'uninstall' ? <UninstallTab /> : null}
        </section>
      </div>
    </div>
  );
}

