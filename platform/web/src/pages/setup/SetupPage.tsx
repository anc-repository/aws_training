/**
 * P00 首次进入与账号预检 `/setup?step=<1..7>&next=<原目标>`（08 §4 P00；01 §4.1、§4.3；02 §3.5、§10.4）。
 * 学员七步：平台是什么 · 平台体检 · 区域与限额 · 预算与通知 · 已有实验与残留 · 个人资料 · 选择学习路径；助教、观察者只有 1 与 6。
 * - 数据全部来自安装时的体检结果与平台配置，本画面不创建任何 AWS 资源；“重新体检”依赖未登记的路由（§9.2 #5），不显示；
 * - 步骤可以任意跳转（左侧列表是链接，窄屏为下拉）；完成只要求：第 1 步勾选、第 6 步显示名非空、第 7 步选择路径；
 * - 完成：PATCH /me（显示名、证书署名、当前路径）+ 写入首次设置完成（onboarding；回写前另存 localStorage `atl.onboarded.v1`），
 *   然后去 next / 当前会话的去处 / 卡片目录；“跳过”同样写入完成，进入 /labs 并提示一次“首次设置已跳过”；
 * - 草稿存 sessionStorage，步骤之间切换不丢输入；`PATCH /me` 失败时保留输入并显示错误与重试。
 */
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { isApiError } from '../../api/errors';
import { useAuth, useServices, useSessionSync } from '../../app/context';
import { useGlobalStatus } from '../../app/globalStatus';
import { pillTarget } from '../../app/sessionRouting';
import { safeNext } from '../../auth/authService';
import { msg, t } from '../../i18n';
import { formatClock, formatCountdown, formatDate } from '../../lib/format';
import { redact } from '../../lib/redact';
import { lsGet, lsSet, ssGet, ssSet } from '../../lib/storage';
import { BUDGET_META, Button, CommandBlock, ErrorPanel, Field, SessionStatePill, Shape, Skeleton, useSecondTick } from '../../ui';
import '../labs/catalog.css';
import { NOTIFY_PREF_KEY, SETUP_SKIPPED_KEY } from '../labs/keys';
import { useCatalog, useResource } from '../labs/data';
import { minCardsOf } from '../labs/model';
import { preflightTitle, PREFLIGHT_TEXT, VERDICT_META, verdictOf, type PreflightItem } from './preflight';
import { SU } from './strings';

const DRAFT_KEY = 'atl.setup.draft.v1';

interface Draft {
  ack: boolean;
  displayName: string | null;
  certName: string | null;
  trackId: string | null;
}

const ALL_STEPS = [1, 2, 3, 4, 5, 6, 7] as const;
type Step = (typeof ALL_STEPS)[number];

export default function SetupPage() {
  const [sp] = useSearchParams();
  const navigate = useNavigate();
  const { api, clock } = useServices();
  const auth = useAuth();
  const role = auth.principal?.role ?? null;
  const L = role === 'L';
  const status = useGlobalStatus();
  const { current } = useSessionSync();
  const catalog = useCatalog();
  const steps: readonly Step[] = L ? ALL_STEPS : [1, 6];
  const raw = Number(sp.get('step') ?? '1') as Step;
  const step: Step = steps.includes(raw) ? raw : steps[0]!;
  const next = sp.get('next');
  const [draft, setDraftState] = useState<Draft>(() => ssGet<Draft>(DRAFT_KEY, { ack: false, displayName: null, certName: null, trackId: null }));
  const [notify, setNotify] = useState<boolean>(() => lsGet<boolean>(NOTIFY_PREF_KEY, false));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<unknown>(null);
  const env = useResource<Record<string, unknown> | null>(L && step === 5 ? 'env-current' : null, () => api.get<Record<string, unknown>>('getCurrentEnvironment'));
  useSecondTick(step === 5 && !!current);

  const me = status.me;
  const displayName = draft.displayName ?? me?.displayName ?? '';
  const certName = draft.certName ?? me?.certName ?? '';
  const trackId = draft.trackId ?? me?.currentTrackId ?? 'saa-main';
  const setDraft = (patch: Partial<Draft>) =>
    setDraftState((d) => {
      const n = { ...d, ...patch };
      ssSet(DRAFT_KEY, n);
      return n;
    });

  const platform = status.platform.data;
  const items = useMemo(() => ((platform?.preflight?.items ?? []) as PreflightItem[]).map((i) => ({ ...i, verdict: verdictOf(i) })), [platform]);
  const fixItems = items.filter((i) => i.verdict === 'fix');
  const done: Partial<Record<Step, boolean>> = { 1: draft.ack, 6: !!displayName.trim(), 7: !!trackId };
  const complete = !!done[1] && !!done[6] && (!L || !!done[7]);
  const active = current && ['REQUESTED', 'PROVISIONING', 'READY', 'RUNNING', 'EXPIRING', 'ENDING', 'CLEANING', 'KEPT', 'CLEANUP_FAILED'].includes(current.state);
  const activeTarget = active ? pillTarget(current!) : null;
  const toWorkspace = !!current && ['REQUESTED', 'PROVISIONING', 'READY', 'RUNNING', 'EXPIRING'].includes(current.state);

  useEffect(() => {
    const h = document.getElementById('setup-step-h');
    if (h && document.activeElement && document.activeElement.closest('.stepper, [data-setup-nav]')) h.focus();
  }, [step]);

  const stepHref = (n: Step) => {
    const q = new URLSearchParams();
    q.set('step', String(n));
    if (next) q.set('next', next);
    return `/setup?${q.toString()}`;
  };
  const idx = steps.indexOf(step);
  const prev = idx > 0 ? steps[idx - 1] : null;
  const nextStep = idx < steps.length - 1 ? steps[idx + 1] : null;

  const finish = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const body: Record<string, unknown> = { displayName: displayName.trim() };
      if (certName.trim()) body.certName = certName.trim();
      if (L) body.currentTrackId = trackId;
      await api.call('patchMe', { body });
      await status.markOnboarded();
      ssSet(DRAFT_KEY, undefined);
      const dest = next ? safeNext(next, '/labs') : toWorkspace && activeTarget ? activeTarget : '/labs';
      navigate(dest, { replace: true });
    } catch (e) {
      setSaveError(e);
    } finally {
      setSaving(false);
    }
  };

  const skip = async () => {
    await status.markOnboarded();
    ssSet(SETUP_SKIPPED_KEY, true);
    navigate('/labs', { replace: true });
  };

  const region = platform?.region ?? '—';
  const limits = (platform?.limits ?? {}) as { maxSessionMinutes?: number; maxKeepHours?: number; readyIdleMinutes?: number; extension?: { minutes?: number; maxCount?: number } };
  const budget = status.guardrails?.budget ?? null;
  const manual = (status.manual?.items ?? []).filter((m) => m.cleanupState !== 'RESOLVED_BY_LEARNER' && m.cleanupState !== 'DELETED');

  let body: JSX.Element | null = null;
  if (step === 1) {
    body = (
      <div className="stack">
        {!L ? (
          <div className="note blue">
            <Shape name="dot" />
            <span>{t(SU.s1.invited, { role: role ? msg.roles[role] : '' })}</span>
          </div>
        ) : null}
        <p>{SU.s1.p1}</p>
        <p>{SU.s1.p2}</p>
        <p>{SU.s1.p3}</p>
        <details className="disc">
          <summary>{SU.s1.more}</summary>
          <p className="small muted">{SU.s1.moreText}</p>
        </details>
        <label className="chk">
          <input type="checkbox" checked={draft.ack} onChange={(e) => setDraft({ ack: e.target.checked })} data-setup-ack="" />
          <span>{SU.s1.ack}</span>
        </label>
      </div>
    );
  } else if (step === 2) {
    const pre = platform?.preflight ?? null;
    const pass = items.filter((i) => i.verdict === 'pass');
    const shown = items.filter((i) => i.verdict !== 'pass');
    body =
      status.platform.status === 'failed' ? (
        <ErrorPanel error={status.platform.error ?? { code: 'INTERNAL' }} onRetry={status.retryPlatform} />
      ) : !pre?.checkedAt ? (
        <p className="note">{SU.s2.empty}</p>
      ) : (
        <div className="stack" data-preflight="">
          <div className="row between">
            <span className="muted small">{SU.s2.lead}</span>
            <span className="small faint">{t(SU.s2.checkedAt, { t: formatDate(pre.checkedAt, clock.now()) })}</span>
          </div>
          <div className="chks">
            {shown.map((i) => {
              const m = PREFLIGHT_TEXT[i.id];
              const v = VERDICT_META[i.verdict];
              const raw = i.message ?? i.detail;
              const amber = i.id === 'borrowable-compute';
              const content = (
                <div className="stack-8">
                  <b>{preflightTitle(i)}</b>
                  {m?.body ? <span className="small muted">{m.body}</span> : null}
                  {m?.command ? <CommandBlock text={(i.fix?.command ?? m.command(region)).trim()} runsOn="local" copyOnly /> : i.fix?.command ? <CommandBlock text={i.fix.command} runsOn="local" copyOnly /> : null}
                  {m?.dangerCommand ? (
                    <details className="disc">
                      <summary>{SU.s2.confirmDelete}</summary>
                      <CommandBlock text={m.dangerCommand(region)} runsOn="local" copyOnly danger />
                    </details>
                  ) : null}
                  {m?.link || i.fix?.url ? (
                    <a href={i.fix?.url ?? m!.link!.url(region)} target="_blank" rel="noopener noreferrer">
                      {m?.link?.label ?? SU.s2.open} ↗<span className="sr">{msg.app.newTab}</span>
                    </a>
                  ) : null}
                  {i.resources?.length ? (
                    <div className="tbl-wrap">
                      <table className="tbl">
                        <thead>
                          <tr>
                            <th scope="col">{SU.s2.type}</th>
                            <th scope="col">{SU.s2.name}</th>
                            <th scope="col">{SU.s2.roleCol}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {i.resources.map((r, k) => (
                            <tr key={k}>
                              <td>{r.type ?? '—'}</td>
                              <td className="mono">{redact(r.name ?? '—')}</td>
                              <td className="mono">{r.role ?? '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : null}
                  {raw ? <span className="small faint">{t(SU.s2.raw, { text: redact(raw) })}</span> : null}
                  {i.hint && !m ? <span className="small muted">{i.hint}</span> : null}
                </div>
              );
              return (
                <div key={i.id} className={amber ? 'chkrow pfrow amber' : 'chkrow pfrow'} data-preflight-item={i.id} data-verdict={i.verdict}>
                  <span className={`st ${v.tone}`}>
                    <Shape name={v.shape} />
                    <span className="t">{v.text}</span>
                  </span>
                  {amber ? (
                    <details open>
                      <summary>
                        <b>{preflightTitle(i)}</b>
                      </summary>
                      {content}
                    </details>
                  ) : (
                    content
                  )}
                </div>
              );
            })}
            {pass.length ? (
              <div className="chkrow pfrow">
                <span className="st pass">
                  <Shape name="check" />
                  <span className="t">{VERDICT_META.pass.text}</span>
                </span>
                <details>
                  <summary>{t(SU.s2.passed, { n: pass.length, list: pass.slice(0, 4).map(preflightTitle).join('、') })}</summary>
                  <ul className="small">
                    {pass.map((i) => (
                      <li key={i.id}>{preflightTitle(i)}</li>
                    ))}
                  </ul>
                </details>
              </div>
            ) : null}
          </div>
          <p className="small muted">{SU.s2.after}</p>
        </div>
      );
  } else if (step === 3) {
    const ext = limits.extension ?? {};
    body =
      status.platform.status === 'failed' ? (
        <ErrorPanel error={status.platform.error ?? { code: 'INTERNAL' }} onRetry={status.retryPlatform} />
      ) : (
        <div className="stack">
          <dl className="kv">
            <dt>{SU.s3.region}</dt>
            <dd>
              <span className="mono">{region}</span>（{SU.s3.regionFixed}）
            </dd>
            <dt>{SU.s3.dr}</dt>
            <dd>{platform?.drRegion ? <span className="mono">{platform.drRegion}</span> : SU.s3.drNone}</dd>
            <dt>{SU.s3.usEast1}</dt>
            <dd>{SU.s3.usEast1Use}</dd>
          </dl>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th scope="col">{SU.s3.limit}</th>
                  <th scope="col">{SU.s3.value}</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>{SU.s3.maxSession}</td>
                  <td className="tnum">{limits.maxSessionMinutes != null ? t(SU.s3.minutes, { n: limits.maxSessionMinutes }) : '—'}</td>
                </tr>
                <tr>
                  <td>{SU.s3.extension}</td>
                  <td>{ext.maxCount != null ? t(SU.s3.extensionValue, { n: ext.maxCount, m: ext.minutes ?? '—' }) : '—'}</td>
                </tr>
                <tr>
                  <td>{SU.s3.keep}</td>
                  <td>{limits.maxKeepHours != null ? t(SU.s3.hours, { n: limits.maxKeepHours }) : '—'}</td>
                </tr>
                <tr>
                  <td>{SU.s3.readyIdle}</td>
                  <td>{limits.readyIdleMinutes != null ? t(SU.s3.readyIdleValue, { n: limits.readyIdleMinutes }) : '—'}</td>
                </tr>
                <tr>
                  <td>{SU.s3.instanceTypes}</td>
                  <td className="mono">{(platform?.allowedInstanceTypes ?? []).join(' · ') || '—'}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      );
  } else if (step === 4) {
    const unset = !budget || !budget.amount;
    body = (
      <div className="stack">
        {unset ? (
          <div className="box inset stack-8" data-budget="unset">
            <b>{SU.s4.suggestTitle}</b>
            <p className="small">{SU.s4.suggest1}</p>
            <p className="small">{SU.s4.suggest2}</p>
            <ul className="small">
              <li>
                <code>MonthlyBudgetAmount</code> {SU.s4.paramAmount}
              </li>
              <li>
                <code>BudgetEnforcement</code> {SU.s4.paramEnforcement}
              </li>
            </ul>
            <a href={`https://console.aws.amazon.com/cloudformation/home?region=${encodeURIComponent(region)}`} target="_blank" rel="noopener noreferrer">
              {SU.s4.openCfn} ↗<span className="sr">{msg.app.newTab}</span>
            </a>
            <div className="note">
              <span>{SU.s4.delay}</span>
            </div>
          </div>
        ) : (
          <div className="box stack-8" data-budget={budget.state}>
            <div className="row between">
              <b>{SU.s4.budgetName}</b>
              <span className={`st ${BUDGET_META[budget.state].tone}`}>
                <Shape name={BUDGET_META[budget.state].shape} />
                <span className="t">{BUDGET_META[budget.state].text}</span>
              </span>
            </div>
            <dl className="kv">
              <dt>{SU.s4.amount}</dt>
              <dd className="tnum">{String(budget.amount)}</dd>
              <dt>{SU.s4.enforcement}</dt>
              <dd>{SU.s4.enforcementText[budget.enforcement as keyof typeof SU.s4.enforcementText] ?? budget.enforcement}</dd>
              {budget.stateAt ? (
                <>
                  <dt>{SU.s4.stateAt}</dt>
                  <dd>{formatDate(budget.stateAt, clock.now())}</dd>
                </>
              ) : null}
            </dl>
          </div>
        )}
        <p className="small">{SU.s4.mail}</p>
        <p className="small muted">{SU.s4.tags}</p>
      </div>
    );
  } else if (step === 5) {
    const kept = env.data && (env.data.session as { state?: string } | null)?.state === 'KEPT' ? env.data : null;
    const keptSession = kept?.session as { labId?: string; sessionId?: string } | undefined;
    const hourly = manual.filter((m) => m.billing === 'hourly').length;
    body = (
      <div className="stack" data-setup-step5="">
        {active && current && current.state !== 'KEPT' ? (
          <div className="box row between">
            <div className="stack-4">
              <b>{SU.s5.current}</b>
              <div className="row">
                <span className="mono">{current.labId}</span>
                <SessionStatePill state={current.state} size="sm" />
                {current.deadlineAt && ['READY', 'RUNNING', 'EXPIRING'].includes(current.state) ? (
                  <span className="small">{t(SU.s5.remaining, { t: formatCountdown(Date.parse(current.deadlineAt) - clock.now()) })}</span>
                ) : null}
              </div>
            </div>
            {activeTarget ? (
              <Link className="btn" to={activeTarget}>
                {toWorkspace ? SU.s5.toWorkspace : SU.s5.toReclaim}
              </Link>
            ) : null}
          </div>
        ) : null}
        {kept || current?.state === 'KEPT' ? (
          <div className="box row between">
            <div className="stack-4">
              <b>{SU.s5.kept}</b>
              <span className="small">
                {t(SU.s5.keptText, {
                  labId: keptSession?.labId ?? current?.labId ?? '—',
                  until: (kept?.keepUntil as string | undefined) ?? current?.keep?.until ? formatClock(String((kept?.keepUntil as string | undefined) ?? current?.keep?.until)) : '—',
                })}
              </span>
            </div>
            <Link className="btn" to={`/sessions/${keptSession?.sessionId ?? current?.sessionId ?? ''}/end`}>
              {SU.s5.manageKept}
            </Link>
          </div>
        ) : null}
        {role !== 'O' && manual.length ? (
          <div className="box row between">
            <div className="stack-4">
              <b>{SU.s5.residual}</b>
              <span className="small">{t(SU.s5.residualText, { n: manual.length, h: hourly })}</span>
            </div>
            <Link className="btn" to="/resources/manual">
              {SU.s5.viewList}
            </Link>
          </div>
        ) : null}
        {!active && !kept && !manual.length ? <p>{SU.s5.none}</p> : null}
      </div>
    );
  } else if (step === 6) {
    body = (
      <div className="stack maxw-520">
        {!me && !status.meLoaded ? <Skeleton lines={2} /> : null}
        <Field label={SU.s6.displayName} error={displayName.trim() ? null : SU.s6.nameRequired}>
          <input className="input" value={displayName} maxLength={64} onChange={(e) => setDraft({ displayName: e.target.value })} data-setup-name="" />
        </Field>
        <Field label={SU.s6.certName}>
          <input className="input" value={certName} maxLength={64} onChange={(e) => setDraft({ certName: e.target.value })} />
        </Field>
        <label className="chk">
          <input
            type="checkbox"
            checked={notify}
            onChange={(e) => {
              const on = e.target.checked;
              setNotify(on);
              lsSet(NOTIFY_PREF_KEY, on);
              if (on && typeof Notification !== 'undefined' && Notification.permission === 'default') void Notification.requestPermission().catch(() => undefined);
            }}
          />
          <span>{SU.s6.notify}</span>
        </label>
      </div>
    );
  } else {
    const tracks = catalog.index?.tracks ?? [];
    body = (
      <div className="stack" data-setup-step7="">
        {catalog.error && !catalog.index ? <ErrorPanel error={catalog.error} onRetry={catalog.reload} /> : null}
        {!catalog.index && !catalog.error ? <Skeleton lines={4} /> : null}
        <fieldset className="plain">
          <legend className="sr">{SU.steps[6]}</legend>
          <div className="grid-2">
            {tracks.map((tr) => (
              <label key={tr.id} className={tr.id === trackId ? 'box chk trkpick on' : 'box chk trkpick'}>
                <input type="radio" name="setup-track" value={tr.id} checked={tr.id === trackId} onChange={() => setDraft({ trackId: tr.id })} />
                <span className="stack-4">
                  <b>
                    {tr.title ?? tr.id} <span className="mono small faint">{tr.id}</span>
                  </b>
                  {tr.audience ? <span className="small muted">{tr.audience}</span> : null}
                  <span className="small">
                    {t(SU.s7.meta, { n: minCardsOf(tr), h: Math.round((tr.requiredMinutes ?? 0) / 60), cert: tr.certificate?.title ?? '—' })}
                  </span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      </div>
    );
  }

  const finishLabel = toWorkspace ? SU.finishToWorkspace : SU.finish;
  return (
    <div className="stack-16" data-screen="P00" data-step={step}>
      <div className="ph">
        <div className="stack-4">
          <h1 tabIndex={-1}>{SU.title}</h1>
          <span className="sub">{SU.sub}</span>
        </div>
      </div>
      <div className="sidenav-layout">
        <div>
          <nav className="stepper sidenav" aria-label={SU.navLabel} data-setup-nav="">
            {steps.map((n) => (
              <Link key={n} to={stepHref(n)} aria-current={n === step ? 'step' : undefined}>
                {done[n] ? (
                  <span className="st pass">
                    <Shape name="check" />
                  </span>
                ) : n === step ? (
                  <span className="st live">
                    <Shape name="dot" />
                  </span>
                ) : (
                  <span className="st faint">
                    <Shape name="ring" />
                  </span>
                )}
                <span>
                  {n} {SU.steps[n - 1]}
                  {done[n] ? <span className="sr">（{SU.done}）</span> : null}
                </span>
              </Link>
            ))}
            <Button variant="ghost" size="sm" className="skip-btn" onClick={() => void skip()} data-setup-skip="">
              {SU.skip}
            </Button>
          </nav>
        </div>
        <section className="stack-16" aria-labelledby="setup-step-h">
          <select className="input sidenav-select" aria-label={SU.selectLabel} value={step} onChange={(e) => navigate(stepHref(Number(e.target.value) as Step))}>
            {steps.map((n) => (
              <option key={n} value={n}>
                {t(SU.stepOf, { i: n, n: 7, name: SU.steps[n - 1] })}
              </option>
            ))}
          </select>
          <h2 id="setup-step-h" tabIndex={-1}>
            {step} {SU.steps[step - 1]}
          </h2>
          {body}
          {saveError ? <ErrorPanel error={isApiError(saveError) ? saveError : { code: 'INTERNAL', title: String(saveError) }} onRetry={() => void finish()} /> : null}
          <div className="row right-actions">
            {prev ? (
              <Link className="btn" to={stepHref(prev)}>
                {SU.prev}
              </Link>
            ) : null}
            {nextStep ? (
              <Link className="btn primary" to={stepHref(nextStep)}>
                {t(SU.next, { name: SU.steps[nextStep - 1] })}
              </Link>
            ) : (
              <Button variant="primary" busy={saving} busyText={SU.saving} disabledReason={complete ? null : SU.incomplete} onClick={() => void finish()} data-setup-finish="">
                {finishLabel}
              </Button>
            )}
            {!nextStep && L && fixItems.length ? <span className="small muted">{t(SU.s7.fixLeft, { n: fixItems.length, list: fixItems.map(preflightTitle).join('、') })}</span> : null}
          </div>
        </section>
      </div>
    </div>
  );
}
