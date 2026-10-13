/**
 * P12 的 workspace（平台设置）、members（成员）、audit（审计）、uninstall（卸载三步）页签（08 §4 P12）。
 * - 平台设置：PATCH /settings 只提交变化的字段并带 If-Match: ver；412 时刷新并提示“设置刚被修改”；超出安装参数上限
 *   （400 VALIDATION_FAILED 的字段错误）回填到字段旁；保存后提示“下一次开始实验时生效”；
 * - 审计：来源只显示 actor.via；来源 IP 对助教不显示，对学员经打码器打码、可临时还原；
 * - 卸载：① 导出（POST /platform/exports 以同一 Idempotency-Key 每 10 秒重试，最多 10 分钟）与待人工处理清单的
 *   Markdown / JSON；② 阻塞项（GET /platform/uninstall/status 每 10 秒）+ 输入 atl 确认 → POST /platform/uninstall/prepare；
 *   ③ ready 且终止保护已关闭后出现删除平台栈的说明。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { isApiError, type ApiError } from '../../api/errors';
import type { ManualResource } from '../../api/types';
import { useAuth, useServices, useSessionSync } from '../../app/context';
import { useGlobalStatus } from '../../app/globalStatus';
import { t, zhCN } from '../../i18n/zh-CN';
import { formatClock, formatDate } from '../../lib/format';
import { redact } from '../../lib/redact';
import { Button, DataTable, Dialog, EmptyState, ErrorPanel, Field, SESSION_STATE_META, Shape, Skeleton, type Column } from '../../ui';
import { useResource } from '../labs/data';
import { canDeleteStack, fieldErrorsFrom, formFromSettings, manualJson, manualMarkdown, settingsPatch, type SettingsForm, type SettingsView, type UninstallStatus } from './model';
import { ST } from './strings';

// ---------------------------------------------------------------------------------------------------------------
// workspace（平台设置）

export function WorkspaceTab({ readOnly }: { readOnly: boolean }) {
  const { api } = useServices();
  const status = useGlobalStatus();
  const { current } = useSessionSync();
  const settings = useResource<SettingsView>('settings', () => api.get<SettingsView>('getSettings'));
  const base = useMemo(() => formFromSettings(settings.data), [settings.data]);
  const [form, setForm] = useState<SettingsForm | null>(null);
  const [errors, setErrors] = useState<Partial<Record<keyof SettingsForm, string>>>({});
  const [msg, setMsg] = useState<{ tone: 'ok' | 'warn'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  if (settings.error && !settings.data) return <ErrorPanel error={settings.error} onRetry={settings.reload} />;
  if (!settings.data) return <Skeleton lines={8} />;
  const f = form ?? base;
  const set = <K extends keyof SettingsForm>(k: K, v: SettingsForm[K]) => {
    setForm({ ...f, [k]: v });
    setErrors((e) => {
      const { [k]: _drop, ...rest } = e;
      return rest;
    });
    setMsg(null);
  };
  const active = current && !['ENDED', 'FAILED'].includes(current.state);
  const features = (status.platform.data?.features ?? {}) as { terminalRecording?: string; workstation?: { instanceType?: string } | null };
  const save = async () => {
    const { patch, errors: local } = settingsPatch(base, f);
    if (Object.keys(local).length) {
      setErrors(local);
      return;
    }
    if (!Object.keys(patch).length) {
      setMsg({ tone: 'ok', text: ST.saved });
      return;
    }
    setBusy(true);
    try {
      await api.call('patchSettings', { body: patch, ifMatch: settings.data?.ver ?? undefined });
      setForm(null);
      settings.reload();
      setMsg({ tone: 'ok', text: ST.savedNext });
    } catch (e) {
      if (isApiError(e) && (e.code === 'PRECONDITION_FAILED' || e.status === 412)) {
        setForm(null);
        settings.reload();
        setMsg({ tone: 'warn', text: ST.conflict });
      } else if (isApiError(e) && e.code === 'VALIDATION_FAILED') {
        const errs = ((e.problem as { errors?: { path: string; message: string }[] } | null)?.errors ?? []).map((x) => ({ path: x.path, message: t(ST.workspace.capError, { detail: x.message }) }));
        setErrors(fieldErrorsFrom(errs));
        if (!errs.length) setMsg({ tone: 'warn', text: e.detail ?? e.title });
      } else setMsg({ tone: 'warn', text: isApiError(e) ? (e.detail ?? e.title) : String(e) });
    } finally {
      setBusy(false);
    }
  };
  const numField = (k: keyof SettingsForm, label: string) => (
    <Field key={k} label={label} error={errors[k] ?? null}>
      <input className="input" inputMode="numeric" value={String(f[k])} disabled={readOnly} onChange={(e) => set(k, e.target.value as never)} />
    </Field>
  );
  return (
    <div className="stack-16 maxw-640" data-tab="workspace">
      <p className="small muted">{ST.workspace.lead}</p>
      {active ? (
        <div className="note amber">
          <Shape name="tri" />
          <span>{ST.activeNote}</span>
        </div>
      ) : null}
      <fieldset className="plain stack">
        <legend className="flabel">{ST.workspace.limitsTitle}</legend>
        {numField('readyIdleMinutes', ST.workspace.readyIdle)}
        {numField('maxKeepHours', ST.workspace.maxKeep)}
        {numField('maxSessionMinutes', ST.workspace.maxSession)}
        {numField('extMinutes', ST.workspace.extMinutes)}
        {numField('extCount', ST.workspace.extCount)}
      </fieldset>
      <fieldset className="plain stack">
        <legend className="flabel">{ST.workspace.terminalTitle}</legend>
        <Field label={ST.workspace.persistence} error={errors.persistence ?? null}>
          <select className="input" value={f.persistence} disabled={readOnly} onChange={(e) => set('persistence', e.target.value)}>
            <option value="">—</option>
            <option value="none">none</option>
            <option value="tmux">tmux</option>
          </select>
        </Field>
        <Field label={ST.workspace.signing} error={errors.streamUrlSigning ?? null}>
          <input className="input mono" value={f.streamUrlSigning} disabled={readOnly} onChange={(e) => set('streamUrlSigning', e.target.value)} />
        </Field>
        {numField('keepalive', ST.workspace.keepalive)}
        <Field label={ST.workspace.recording}>
          <input className="input" value={features.terminalRecording ?? 'off'} disabled readOnly />
        </Field>
        <Field label={ST.workspace.instanceType}>
          <input className="input mono" value={settings.data.workstation?.instanceType ?? features.workstation?.instanceType ?? '—'} disabled readOnly />
        </Field>
        <label className="chk">
          <input type="checkbox" checked={f.longSession} disabled={readOnly} onChange={(e) => set('longSession', e.target.checked)} />
          <span>{ST.workspace.longSession}</span>
        </label>
      </fieldset>
      <fieldset className="plain stack">
        <legend className="flabel">{ST.workspace.previewTitle}</legend>
        <Field label={ST.workspace.directHttps} error={errors.directHttps ?? null}>
          <select className="input" value={f.directHttps} disabled={readOnly} onChange={(e) => set('directHttps', e.target.value)}>
            <option value="">—</option>
            <option value="letsencrypt-ip">letsencrypt-ip</option>
            <option value="off">off</option>
          </select>
        </Field>
        <Field label={ST.workspace.lateUpload} error={errors.lateUploadFallback ?? null}>
          <select className="input" value={f.lateUploadFallback} disabled={readOnly} onChange={(e) => set('lateUploadFallback', e.target.value)}>
            <option value="">—</option>
            <option value="on">{ST.workspace.on}</option>
            <option value="off">{ST.workspace.off}</option>
          </select>
        </Field>
        <Field label={ST.workspace.residual} error={errors.blockStartOnResidual ?? null}>
          <select className="input" value={f.blockStartOnResidual} disabled={readOnly} onChange={(e) => set('blockStartOnResidual', e.target.value)}>
            <option value="ack">{ST.workspace.residualAck}</option>
            <option value="block">{ST.workspace.residualBlock}</option>
            <option value="ignore">{ST.workspace.residualIgnore}</option>
          </select>
        </Field>
        {numField('maxWaitMinutes', ST.workspace.ownership)}
      </fieldset>
      <div className="row">
        <Button variant="primary" busy={busy} busyText={ST.saving} disabledReason={readOnly ? ST.readonly : null} onClick={() => void save()} data-settings-save="">
          {ST.save}
        </Button>
        {msg ? (
          <span className={msg.tone === 'ok' ? 'small st pass' : 'small st drift'} role="status">
            <Shape name={msg.tone === 'ok' ? 'check' : 'tri'} />
            <span className="t">{msg.text}</span>
          </span>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// members

interface Member {
  sub: string;
  email: string;
  role: string;
  displayName?: string | null;
  invitedAt?: string | null;
  createdAt?: string | null;
}

const ROLE_NAME: Readonly<Record<string, string>> = { learner: zhCN.roles.L, assistant: zhCN.roles.A, observer: zhCN.roles.O };

export function MembersTab({ readOnly }: { readOnly: boolean }) {
  const { api, clock } = useServices();
  const members = useResource<{ items: Member[] }>('members', () => api.get<{ items: Member[] }>('listMembers'));
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'assistant' | 'observer'>('assistant');
  const [inviteState, setInviteState] = useState<{ busy: boolean; error: string | null; done: boolean }>({ busy: false, error: null, done: false });
  const [removing, setRemoving] = useState<Member | null>(null);
  const [removeState, setRemoveState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const invite = async () => {
    if (!/^[^\s@"'`$;|&<>]+@[^\s@"'`$;|&<>]+\.[^\s@"'`$;|&<>]+$/.test(email.trim())) {
      setInviteState({ busy: false, error: ST.members.emailInvalid, done: false });
      return;
    }
    setInviteState({ busy: true, error: null, done: false });
    try {
      await api.call('inviteMember', { body: { email: email.trim(), role } });
      setEmail('');
      setInviteState({ busy: false, error: null, done: true });
      members.reload();
    } catch (e) {
      setInviteState({ busy: false, error: isApiError(e) ? (e.detail ?? e.title) : String(e), done: false });
    }
  };
  const remove = async () => {
    if (!removing) return;
    setRemoveState({ busy: true, error: null });
    try {
      await api.call('deleteMember', { params: { sub: removing.sub } });
      setRemoving(null);
      setRemoveState({ busy: false, error: null });
      members.reload();
    } catch (e) {
      setRemoveState({ busy: false, error: isApiError(e) ? (e.detail ?? e.title) : String(e) });
    }
  };
  const cols: Column<Member>[] = [
    { key: 'who', header: ST.members.member, render: (m) => <span className="wrap-any">{[m.displayName, m.email].filter(Boolean).join(' · ')}</span> },
    { key: 'role', header: ST.members.role, render: (m) => ROLE_NAME[m.role] ?? m.role },
    { key: 'at', header: ST.members.invitedAt, render: (m) => (m.invitedAt ? formatDate(m.invitedAt, clock.now()) : '—') },
    {
      key: 'act',
      header: '',
      render: (m) =>
        m.role !== 'learner' && !readOnly ? (
          <Button size="sm" variant="danger" aria-label={t(ST.members.removeLabel, { name: m.displayName ?? m.email })} onClick={() => setRemoving(m)}>
            {ST.members.remove}
          </Button>
        ) : null,
    },
  ];
  return (
    <div className="stack-16" data-tab="members">
      <p className="small muted">{ST.members.note}</p>
      {members.error && !members.data ? <ErrorPanel error={members.error} onRetry={members.reload} /> : null}
      {members.data ? <DataTable columns={cols} rows={members.data.items} rowKey={(m) => m.sub} caption={ST.tabs.members} cardify empty={<EmptyState>{ST.members.empty}</EmptyState>} /> : !members.error ? <Skeleton lines={3} /> : null}
      {!readOnly ? (
        <div className="stack-8">
          <div className="member-invite">
            <Field label={ST.members.inviteEmail} error={inviteState.error}>
              <input className="input" type="email" value={email} autoComplete="off" onChange={(e) => setEmail(e.target.value)} />
            </Field>
            <Field label={ST.members.inviteRole}>
              <select className="input auto" value={role} onChange={(e) => setRole(e.target.value as 'assistant' | 'observer')}>
                <option value="assistant">{zhCN.roles.A}</option>
                <option value="observer">{zhCN.roles.O}</option>
              </select>
            </Field>
            <Button busy={inviteState.busy} busyText={ST.members.inviting} onClick={() => void invite()}>
              {ST.members.invite}
            </Button>
          </div>
          {inviteState.done ? (
            <p className="small st pass" role="status">
              <Shape name="check" />
              <span className="t">{ST.members.invited}</span>
            </p>
          ) : null}
        </div>
      ) : null}
      <Dialog
        open={!!removing}
        onClose={() => setRemoving(null)}
        title={ST.members.removeTitle}
        size="narrow"
        alert
        initialFocus="[data-cancel]"
        footer={
          <>
            <Button onClick={() => setRemoving(null)} data-cancel="">
              {zhCN.app.cancel}
            </Button>
            <Button variant="danger-solid" busy={removeState.busy} onClick={() => void remove()}>
              {ST.members.remove}
            </Button>
          </>
        }
      >
        {removing ? <p>{t(ST.members.removeBody, { name: removing.displayName ?? removing.email, role: ROLE_NAME[removing.role] ?? removing.role })}</p> : null}
        {removeState.error ? (
          <p className="note red" role="alert">
            {removeState.error}
          </p>
        ) : null}
      </Dialog>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// audit

interface AuditEvent {
  auditId?: string;
  at: string;
  action: string;
  actor?: { sub?: string | null; role?: string; via?: string };
  target?: string | null;
  sessionId?: string | null;
  result?: string;
  sourceIp?: string | null;
}

export function AuditTab() {
  const { api, clock } = useServices();
  const auth = useAuth();
  const L = auth.principal?.role === 'L';
  const [draft, setDraft] = useState({ sessionId: '', from: '', to: '' });
  const [applied, setApplied] = useState(draft);
  const [unmask, setUnmask] = useState(false);
  const key = `audit:${JSON.stringify(applied)}`;
  const events = useResource<{ items: AuditEvent[] }>(key, () =>
    api.get<{ items: AuditEvent[] }>('listAuditEvents', {
      query: {
        sessionId: applied.sessionId.trim() || undefined,
        from: applied.from ? new Date(`${applied.from}T00:00:00`).toISOString() : undefined,
        to: applied.to ? new Date(`${applied.to}T23:59:59`).toISOString() : undefined,
      },
    }),
  );
  const resultText = (r?: string) => (r === 'ok' ? ST.audit.resultOk : r === 'denied' ? ST.audit.resultDenied : r === 'error' ? ST.audit.resultError : (r ?? '—'));
  const cols: Column<AuditEvent>[] = [
    { key: 'at', header: ST.audit.time, render: (e) => <span className="tnum nowrap" title={e.at}>{formatDate(e.at, clock.now())}</span> },
    { key: 'actor', header: ST.audit.actor, render: (e) => `${e.actor?.sub ?? '—'}（${ROLE_NAME[e.actor?.role ?? ''] ?? e.actor?.role ?? '—'}）` },
    { key: 'action', header: ST.audit.action, render: (e) => <span className="mono small">{e.action}</span> },
    { key: 'target', header: ST.audit.target, render: (e) => <span className="mono small wrap-any">{e.target ?? e.sessionId ?? '—'}</span> },
    { key: 'result', header: ST.audit.result, render: (e) => resultText(e.result) },
    {
      key: 'src',
      header: ST.audit.source,
      render: (e) => (
        <span className="small">
          {ST.audit.via[e.actor?.via ?? ''] ?? e.actor?.via ?? '—'}
          {L && e.sourceIp ? (
            <>
              {' · '}
              <span className="mono">{unmask ? e.sourceIp : redact(e.sourceIp)}</span>
            </>
          ) : null}
        </span>
      ),
    },
  ];
  return (
    <div className="stack-16" data-tab="audit">
      <form
        className="row top"
        onSubmit={(e) => {
          e.preventDefault();
          setApplied(draft);
        }}
      >
        <Field label={ST.audit.session}>
          <input className="input mono" value={draft.sessionId} onChange={(e) => setDraft({ ...draft, sessionId: e.target.value })} />
        </Field>
        <Field label={ST.audit.from}>
          <input className="input" type="date" value={draft.from} onChange={(e) => setDraft({ ...draft, from: e.target.value })} />
        </Field>
        <Field label={ST.audit.to}>
          <input className="input" type="date" value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value })} />
        </Field>
        <Button type="submit">{ST.audit.apply}</Button>
      </form>
      {events.error && !events.data ? <ErrorPanel error={events.error} onRetry={events.reload} /> : null}
      {events.data ? (
        <DataTable columns={cols} rows={events.data.items} rowKey={(e) => e.auditId ?? `${e.at}-${e.action}`} caption={ST.tabs.audit} cardify empty={<EmptyState>{ST.audit.empty}</EmptyState>} />
      ) : !events.error ? (
        <Skeleton lines={5} />
      ) : null}
      <div className="row small">
        {L ? (
          <button type="button" className="linkbtn" aria-pressed={unmask} onClick={() => setUnmask((v) => !v)}>
            {unmask ? ST.audit.hideIp : ST.audit.showIp}
          </button>
        ) : (
          <span className="muted">{ST.audit.ipOnlyLearner}</span>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// uninstall

const EXPORT_RETRY_MS = 10_000;
const EXPORT_MAX_MS = 10 * 60_000;

function downloadText(filename: string, text: string, type: string): void {
  try {
    const blob = new Blob([text], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  } catch {
    /* 浏览器不支持时什么也不做 */
  }
}

function useArchiveExport() {
  const { api, clock } = useServices();
  const [state, setState] = useState<{ phase: 'idle' | 'pending' | 'ready' | 'timeout' | 'error'; url: string | null; at: number | null; error: ApiError | null }>({
    phase: 'idle',
    url: null,
    at: null,
    error: null,
  });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const start = () => {
    const op = api.operation('createExport');
    const began = Date.now();
    setState({ phase: 'pending', url: null, at: null, error: null });
    const attempt = async () => {
      try {
        const r = await op.run<{ status?: string; downloadUrl?: string }>({});
        if (r.data?.status === 'ready' && r.data.downloadUrl) {
          setState({ phase: 'ready', url: r.data.downloadUrl, at: clock.now(), error: null });
          return;
        }
      } catch (e) {
        if (isApiError(e) && !e.isTransient) {
          setState({ phase: 'error', url: null, at: null, error: e });
          return;
        }
      }
      if (Date.now() - began >= EXPORT_MAX_MS) {
        setState({ phase: 'timeout', url: null, at: null, error: null });
        return;
      }
      timer.current = setTimeout(() => void attempt(), EXPORT_RETRY_MS);
    };
    void attempt();
  };
  return { state, start };
}

export function UninstallTab() {
  const { api, clock } = useServices();
  const status = useGlobalStatus();
  const st = useResource<UninstallStatus>('uninstall-status', () => api.get<UninstallStatus>('getUninstallStatus'), { pollMs: 10_000 });
  const archive = useArchiveExport();
  const [typed, setTyped] = useState('');
  const [prep, setPrep] = useState<{ busy: boolean; error: ApiError | null }>({ busy: false, error: null });
  const prepOp = useRef<ReturnType<typeof api.operation> | null>(null);
  const firstSeenUninstalling = useRef<number | null>(null);
  const uninstalling = status.platform.data?.mode === 'UNINSTALLING' || st.data?.mode === 'UNINSTALLING';
  if (uninstalling && firstSeenUninstalling.current === null) firstSeenUninstalling.current = Date.now();
  const slow = uninstalling && firstSeenUninstalling.current !== null && Date.now() - firstSeenUninstalling.current > 3_600_000 && !st.data?.ready;
  const manual: (ManualResource & { envId?: string })[] = status.manual?.items ?? [];
  const prepare = async () => {
    if (typed.trim() !== 'atl') return;
    if (!prepOp.current) prepOp.current = api.operation('prepareUninstall');
    setPrep({ busy: true, error: null });
    try {
      await prepOp.current.run({});
      status.retryPlatform();
      st.reload();
      setPrep({ busy: false, error: null });
    } catch (e) {
      // 需要最近登录：全局 ReauthDialog 处理并以同一 Idempotency-Key 重放
      setPrep({ busy: false, error: isApiError(e) && e.code !== 'REAUTH_REQUIRED' ? e : null });
    }
  };
  const now = new Date(clock.now()).toISOString();
  return (
    <div className="u-steps" data-tab="uninstall">
      <div className="note amber">
        <Shape name="tri" />
        <span>{ST.uninstall.warning}</span>
      </div>
      <section className="sec" aria-labelledby="u1-h">
        <h2 id="u1-h">{ST.uninstall.s1}</h2>
        <div className="row between">
          <span>{ST.uninstall.archive}</span>
          <span className="row">
            <Button size="sm" busy={archive.state.phase === 'pending'} busyText={ST.uninstall.generating} onClick={archive.start} data-export="">
              {ST.uninstall.generate}
            </Button>
            {archive.state.phase === 'ready' && archive.state.url ? (
              <>
                <span className="small">{t(ST.uninstall.generatedAt, { t: formatClock(archive.state.at ?? clock.now()) })}</span>
                <a className="btn sm" href={archive.state.url} rel="noopener">
                  {ST.uninstall.download}
                </a>
              </>
            ) : null}
          </span>
        </div>
        {archive.state.phase === 'timeout' ? <p className="small st drift">{ST.uninstall.exportTimeout}</p> : null}
        {archive.state.phase === 'error' && archive.state.error ? <ErrorPanel error={archive.state.error} onRetry={archive.start} /> : null}
        <div className="row between">
          <span>{ST.uninstall.manualList}</span>
          <span className="row">
            <Button size="sm" onClick={() => downloadText(`atl-manual-${now.slice(0, 10)}.md`, manualMarkdown(manual, now), 'text/markdown')}>
              {ST.uninstall.exportMd}
            </Button>
            <Button size="sm" onClick={() => downloadText(`atl-manual-${now.slice(0, 10)}.json`, manualJson(manual, now), 'application/json')}>
              {ST.uninstall.exportJson}
            </Button>
          </span>
        </div>
      </section>
      <section className="sec" aria-labelledby="u2-h">
        <h2 id="u2-h">{ST.uninstall.s2}</h2>
        {st.error && !st.data ? <ErrorPanel error={st.error} onRetry={st.reload} title={ST.uninstall.statusFailed} /> : null}
        <div className="blockers" data-blockers="">
          <b className="small">{ST.uninstall.blockers}</b>
          {st.data ? (
            st.data.blockers.length || st.data.rescanWarning ? (
              <>
                {st.data.blockers.map((b, i) => (
                  <div key={`${b.code}-${b.sessionId ?? i}`} className="small" data-blocker={b.code}>
                    {b.code === 'REVOCATIONS_PENDING' ? (
                      <span className="st pend">
                        <Shape name="clock" />
                        <span className="t">{t(ST.uninstall.blockRevocations, { t: b.until ? formatClock(b.until) : '—' })}</span>
                      </span>
                    ) : (
                      <span className="st fail">
                        <Shape name="xbox" />
                        <span className="t">
                          {b.code === 'SESSION_NOT_TERMINAL'
                            ? t(ST.uninstall.blockSession, { sid: b.sessionId ?? '—', labId: b.labId ?? '—', state: b.state ? (SESSION_STATE_META[b.state as keyof typeof SESSION_STATE_META]?.text ?? b.state) : '—' })
                            : b.code === 'MANUAL_RESIDUALS'
                              ? t(ST.uninstall.blockManual, { n: b.count ?? 0 })
                              : b.code}
                        </span>
                      </span>
                    )}
                    {b.code === 'MANUAL_RESIDUALS' ? (
                      <>
                        {' '}
                        <Link to="/resources/manual">{ST.uninstall.viewList}</Link>
                      </>
                    ) : null}
                  </div>
                ))}
                {st.data.rescanWarning ? (
                  <div className="small">
                    <span className="st drift">
                      <Shape name="tri" />
                      <span className="t">{st.data.rescanWarning}</span>
                    </span>
                  </div>
                ) : null}
              </>
            ) : (
              <span className="small muted">{ST.uninstall.noBlockers}</span>
            )
          ) : !st.error ? (
            <Skeleton lines={2} />
          ) : null}
        </div>
        <div className="maxw-320">
          <Field label={ST.uninstall.confirmLabel} hint={ST.uninstall.confirmHint}>
            <input className="input mono" value={typed} autoComplete="off" spellCheck={false} disabled={uninstalling} onChange={(e) => setTyped(e.target.value)} data-confirm-typing="" />
          </Field>
        </div>
        <div>
          <Button
            variant="danger-solid"
            busy={prep.busy || uninstalling}
            busyText={ST.uninstall.preparing}
            disabled={typed.trim() !== 'atl' && !uninstalling}
            onClick={() => void prepare()}
            data-prepare=""
          >
            {ST.uninstall.prepare}
          </Button>
        </div>
        {prep.error ? <ErrorPanel error={prep.error} onRetry={() => void prepare()} /> : null}
        {slow ? <p className="small muted">{ST.uninstall.slow}</p> : null}
      </section>
      <section className="sec" aria-labelledby="u3-h">
        <h2 id="u3-h">{ST.uninstall.s3}</h2>
        {canDeleteStack(st.data) ? (
          <div className="stack-8" data-delete-stack="">
            <p>
              {ST.uninstall.s3Text}{' '}
              <a href={`https://console.aws.amazon.com/cloudformation/home?region=${encodeURIComponent(status.platform.data?.region ?? '')}`} target="_blank" rel="noopener noreferrer">
                {ST.upgrade.openCfn} ↗<span className="sr">{zhCN.app.newTab}</span>
              </a>
            </p>
            <div className="note amber">
              <Shape name="tri" />
              <span>{ST.uninstall.s3Warn}</span>
            </div>
            <p className="small">{ST.uninstall.s3After}</p>
          </div>
        ) : (
          <p className="small muted">{ST.uninstall.s3Hidden}</p>
        )}
      </section>
    </div>
  );
}
