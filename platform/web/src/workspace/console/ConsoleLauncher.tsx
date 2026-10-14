/**
 * AWS 控制台标签 ConsoleLauncher（08 P05.7；03 §5.3、§5.5～§5.7）：控制台不允许被嵌入，一律在新标签页打开，并提示 1 小时上限。
 *
 * - 打开：点击时**同步** `window.open('about:blank', 'atl-aws-console-<随机串>')` 并立即置 `opener = null`，再
 *   `POST /sessions/{sid}/console-link {destination? | linkId?}` 取得 `form`，以 POST 表单提交到联合端点（SigninToken 不进地址栏）；
 * - 被弹窗拦截：显示“浏览器拦截了新窗口”与普通按钮（`target="_blank"` 提交同一表单）；取得表单超过 10 分钟后改为“重新获取并打开”；
 * - 签发与到期：以 `GET /workspace` 的 `console.lastIssuedAt` / `credentialsExpireAt` 为准（刷新后也能恢复），POST 的
 *   `consoleSessionExpiresAt` 与 `console_link.issued` 事件只用于即时刷新；剩余 10 分钟时琥珀时钟 + “续期”；续期与深链一律新标签页；
 * - 深链：`console.links`；50 分钟内签发过登录时直接 `window.open(deepLink, '_blank', 'noopener')`（sessionStorage 记录签发时间）；
 * - 不显示“已登录”之类的猜测，只显示签发与到期时间。
 */
import { useCallback, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useServices } from '../../app/context';
import { isApiError, type ApiError } from '../../api/errors';
import { announce } from '../../lib/announce';
import { formatClock } from '../../lib/format';
import { ssGet, ssSet } from '../../lib/storage';
import { Button, Icon, Shape, useSecondTick } from '../../ui';
import { useWorkspace } from '../context';
import type { ConsoleLinkResponse, WorkspaceView } from '../data/types';
import type { Resource } from '../data/resource';
import type { WorkspaceReporter } from '../workbench/reporter';

import { msg, t } from '../../i18n';
import { W } from '../strings';
const MIN = 60_000;
export const FORM_STALE_MS = 10 * MIN;
export const DIRECT_DEEPLINK_MS = 50 * MIN;
const ISSUED_KEY = (sid: string) => `atl.ws.console-issued.${sid}.v1`;
const LINKS_KEY = (sid: string) => `atl.ws.console-links.${sid}.v1`;

const WC = W.console;
const LINK_TEXT: Readonly<Record<string, string>> = WC.link;

export function linkLabel(linkId: string, label?: string): string {
  return label ?? LINK_TEXT[linkId] ?? linkId;
}

/** 以 POST 表单提交到联合端点（target 为命名空白窗口或 _blank）。 */
export function submitForm(form: NonNullable<ConsoleLinkResponse['form']>, target: string): void {
  const f = document.createElement('form');
  f.method = (form.method ?? 'POST').toUpperCase() === 'GET' ? 'GET' : 'POST';
  f.action = form.action;
  f.target = target;
  f.rel = 'noopener noreferrer';
  f.hidden = true;
  for (const [k, v] of Object.entries(form.fields ?? {})) {
    const i = document.createElement('input');
    i.type = 'hidden';
    i.name = k;
    i.value = v;
    f.appendChild(i);
  }
  document.body.appendChild(f);
  try {
    f.submit();
  } finally {
    f.remove();
  }
}

export interface ConsoleOpener {
  open: (dest?: { linkId: string; params?: Record<string, string> }, opts?: { forceLogin?: boolean }) => void;
  blocked: { form: NonNullable<ConsoleLinkResponse['form']>; at: number; dest?: { linkId: string; params?: Record<string, string> } } | null;
  error: string | null;
  busy: boolean;
  issuedAt: number | null;
  expiresAt: number | null;
  retryBlocked: () => void;
}

/** 控制台打开流程（ConsoleLauncher 与手册中的 `::console-link` 共用；在工作台上下文之外创建，参数显式传入）。 */
export function useConsoleOpener(o: { sid: string; workspace: Resource<WorkspaceView>; reporter: WorkspaceReporter | null }): ConsoleOpener {
  const { api } = useServices();
  const ws = { sid: o.sid, data: { workspace: o.workspace }, reporter: o.reporter };
  const [blocked, setBlocked] = useState<ConsoleOpener['blocked']>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [local, setLocal] = useState<{ issuedAt: number; expiresAt: number | null } | null>(null);
  const desc = ws.data.workspace.data?.console;
  const serverIssued = desc?.lastIssuedAt ? Date.parse(desc.lastIssuedAt) : null;
  const serverExp = desc?.credentialsExpireAt ? Date.parse(desc.credentialsExpireAt) : null;
  const issuedAt = Math.max(serverIssued ?? 0, local?.issuedAt ?? 0) || null;
  const expiresAt = local && local.issuedAt >= (serverIssued ?? 0) ? (local.expiresAt ?? (local.issuedAt + 60 * MIN)) : (serverExp ?? (serverIssued ? serverIssued + 60 * MIN : null));
  const reporter = ws.reporter;
  const inflight = useRef(false);

  const fetchForm = useCallback(
    async (dest?: { linkId: string; params?: Record<string, string> }): Promise<ConsoleLinkResponse | null> => {
      try {
        const r = await api.call<ConsoleLinkResponse>('createConsoleLink', { params: { sid: ws.sid }, body: dest ? { linkId: dest.linkId } : {} });
        const data = r.data;
        const at = data?.issuedAt ? Date.parse(data.issuedAt) : Date.now();
        setLocal({ issuedAt: at, expiresAt: data?.consoleSessionExpiresAt ? Date.parse(data.consoleSessionExpiresAt) : null });
        ssSet(ISSUED_KEY(ws.sid), at);
        if (dest && (data?.deepLink ?? null)) ssSet(LINKS_KEY(ws.sid), { ...ssGet<Record<string, string>>(LINKS_KEY(ws.sid), {}), [dest.linkId]: data!.deepLink! });
        void ws.data.workspace.refresh();
        return data;
      } catch (e) {
        setError(consoleErrorText(isApiError(e) ? e : null));
        return null;
      }
    },
    [api, ws.sid, ws.data.workspace],
  );

  const open = useCallback(
    (dest?: { linkId: string; params?: Record<string, string> }, opts: { forceLogin?: boolean } = {}) => {
      if (inflight.current) return;
      setError(null);
      reporter?.push('workspace.console_opened', { linkId: dest?.linkId ?? null });
      // 50 分钟内签发过登录：深链直接新标签页打开（浏览器中的控制台登录 Cookie 已存在）
      const lastIssued = ssGet<number | null>(ISSUED_KEY(ws.sid), null);
      const known = dest ? ssGet<Record<string, string>>(LINKS_KEY(ws.sid), {})[dest.linkId] : null;
      if (!opts.forceLogin && dest && known && lastIssued && Date.now() - lastIssued < DIRECT_DEEPLINK_MS) {
        window.open(known, '_blank', 'noopener');
        announce(WC.opened);
        return;
      }
      const name = `atl-aws-console-${Math.random().toString(36).slice(2, 10)}`;
      // 必须在点击事件中同步调用（弹窗拦截）
      const w = window.open('about:blank', name);
      if (w) {
        try {
          w.opener = null;
        } catch {
          /* 忽略 */
        }
      }
      inflight.current = true;
      setBusy(true);
      void fetchForm(dest)
        .then((data) => {
          if (!data?.form && !data?.url) {
            w?.close();
            return;
          }
          if (!w) {
            if (data.form) setBlocked({ form: data.form, at: Date.now(), dest });
            return;
          }
          if (data.form) submitForm(data.form, name);
          else if (data.url) w.location.href = data.url;
          announce(WC.opened);
        })
        .finally(() => {
          inflight.current = false;
          setBusy(false);
        });
    },
    [fetchForm, reporter, ws.sid],
  );

  const retryBlocked = useCallback(() => {
    const b = blocked;
    if (!b) return;
    if (Date.now() - b.at > FORM_STALE_MS) {
      // 登录链接取得后超过 10 分钟不再使用：重新获取并打开
      setBlocked(null);
      open(b.dest, { forceLogin: true });
      return;
    }
    submitForm(b.form, '_blank');
    setBlocked(null);
  }, [blocked, open]);

  return { open, blocked, error, busy, issuedAt, expiresAt, retryBlocked };
}

export function consoleErrorText(e: ApiError | null): string {
  switch (e?.code) {
    case 'CONSOLE_SESSION_STATE':
      return WC.errState;
    case 'CONSOLE_DESTINATION_NOT_ALLOWED':
      return WC.errDestination;
    case 'CONSOLE_FEDERATION_FAILED':
      return WC.errFederation;
    case 'REAUTH_REQUIRED':
      return WC.errReauth;
    case 'NOT_IMPLEMENTED':
      return WC.errNotImplemented;
    case 'RATE_LIMITED':
      return WC.errRate;
    default:
      return e ? t(WC.errOther, { title: e.title }) : WC.errNetwork;
  }
}

export function ConsoleLauncher({ opener }: { opener: ConsoleOpener }) {
  const ws = useWorkspace();
  const navigate = useNavigate();
  useSecondTick(true);
  const desc = ws.data.workspace.data;
  const region = desc?.region ?? (ws.data.vars.data?.session?.region as string | undefined) ?? '—';
  const now = Date.now();
  const st = ws.view.state;
  if (!ws.live) {
    return (
      <div className="cpane stack">
        <div className="empty">
          <b>{st === 'CLEANUP_FAILED' ? WC.cleanupFailedOnly : WC.revoked}</b>
          <span className="small">{WC.permissionsRevoked}</span>
          {st === 'CLEANUP_FAILED' ? (
            <Button size="sm" onClick={() => navigate(`/sessions/${ws.sid}/end#manual`)}>
              {WC.viewManual}
            </Button>
          ) : null}
        </div>
      </div>
    );
  }
  const { issuedAt, expiresAt } = opener;
  const remaining = expiresAt ? expiresAt - now : null;
  const soon = remaining !== null && remaining > 0 && remaining <= 10 * MIN;
  const over = remaining !== null && remaining <= 0;
  const links = desc?.console?.links ?? [];
  const steps = ws.data.lab.data?.steps ?? [];
  const stepNos = (ids?: string[]) => (ids ?? []).map((id) => steps.findIndex((s) => s.id === id) + 1).filter((n) => n > 0);
  return (
    <div className="cpane stack" data-console="">
      <div className="box stack-8">
        <b>{WC.title}</b>
        <dl className="kv">
          <dt>{WC.identity}</dt>
          <dd className="mono">{t(WC.identityValue, { sid: ws.sid })}</dd>
          <dt>{WC.region}</dt>
          <dd className="mono">{region}</dd>
          <dt>{WC.lastIssued}</dt>
          <dd data-issued="">
            {issuedAt ? t(WC.issued, { t: formatClock(issuedAt), until: expiresAt ? formatClock(expiresAt) : '—' }) : WC.notIssued}
            {soon ? (
              <span className="st drift">
                {' '}
                <Shape name="clock" />
                <span className="t">{WC.soon}</span>
              </span>
            ) : null}
            {over ? (
              <span className="st fail">
                {' '}
                <Shape name="xbox" />
                <span className="t">{WC.expired}</span>
              </span>
            ) : null}
          </dd>
        </dl>
        {st === 'EXPIRING' ? (
          <div className="note amber">
            <Shape name="tri" />
            <span>{WC.expiringNote}</span>
          </div>
        ) : null}
        <div className="row">
          <Button variant="primary" icon="ext" onClick={() => opener.open()} busy={opener.busy} busyText={WC.gettingLogin} data-console-open="">
            {WC.open}
          </Button>
          {issuedAt && (soon || over) ? (
            <Button icon="refresh" onClick={() => opener.open(undefined, { forceLogin: true })}>
              {WC.renew}
            </Button>
          ) : null}
        </div>
        {opener.blocked ? (
          <div className="note amber" role="alert">
            <Shape name="tri" />
            <span>
              {WC.popupBlocked}
              <button type="button" className="linkbtn" onClick={opener.retryBlocked}>
                {Date.now() - opener.blocked.at > FORM_STALE_MS ? WC.refetchOpen : WC.openInNewTab}
              </button>
              {WC.linkValidity}
            </span>
          </div>
        ) : null}
        {opener.error ? (
          <p className="small st fail" role="alert">
            {opener.error}
          </p>
        ) : null}
      </div>
      {links.length ? (
        <div className="stack-4">
          <b className="small">{WC.commonPages}</b>
          {links.map((l) => (
            <div className="crow" key={l.linkId}>
              <button type="button" className="linkbtn" onClick={() => opener.open({ linkId: l.linkId })}>
                <Icon name="ext" /> {linkLabel(l.linkId, l.label)}
                <span className="sr">{msg.app.newTab}</span>
              </button>
              {stepNos(l.steps).length ? <span className="small faint">{t(WC.usedBySteps, { list: stepNos(l.steps).join(WC.listSep) })}</span> : null}
            </div>
          ))}
        </div>
      ) : null}
      <button type="button" className="linkbtn small" onClick={() => opener.open(undefined, { forceLogin: true })}>
        {WC.reLogin}
      </button>
      <div className="note">
        <Shape name="dot" />
        <span>{WC.cloudTrailNote}</span>
      </div>
      <div className="note">
        <Icon name="user" />
        <span>{WC.profileNote}</span>
      </div>
    </div>
  );
}
