/**
 * 应用预览 PreviewFrame（08 P05.8；03 §6）：`GET /sessions/{sid}/preview` → `targets[]{id, url, embeddable, reason?, via?}`、`default`；
 * 入口选择存 sessionStorage。只把 `embeddable=true` 的 URL 设为 iframe src（sandbox 不给 allow-top-navigation、referrerpolicy=no-referrer、
 * title 写明入口）；**没有受信 HTTPS 时改为新标签页打开**（MIXED_CONTENT、UNTRUSTED_CERT、FRAME_ANCESTORS_MISSING、X_FRAME_OPTIONS、
 * UNREACHABLE 各有说明）；窄屏（< 768px）默认新标签页。预览不承担检测职责，不加实验头。
 * “管理员账号”：`GET /sessions/{sid}/app-credentials`（敏感操作，no-store）→ 对话框，密码默认遮盖，显示 10 秒，关闭即从内存清除。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useServices } from '../../app/context';
import { isApiError } from '../../api/errors';
import { announce } from '../../lib/announce';
import { copyText } from '../../lib/clipboard';
import { redact } from '../../lib/redact';
import { ssGet, ssSet } from '../../lib/storage';
import { Button, Dialog, Icon, Shape, Skeleton } from '../../ui';
import { useWorkspace } from '../context';
import { useResource } from '../data/resource';
import type { AppCredentials, PreviewTarget, PreviewView } from '../data/types';

import { t as tr } from '../../i18n';
import { W } from '../strings';
const WP = W.preview;
const reasonOf = (key: keyof typeof WP.reason, extra: { hint?: keyof typeof WP.reason; retry?: boolean } = {}) => ({
  get text() {
    return WP.reason[key];
  },
  ...(extra.hint
    ? {
        get hint() {
          return WP.reason[extra.hint!];
        },
      }
    : {}),
  ...(extra.retry ? { retry: true } : {}),
});

export const REASON_TEXT: Record<string, { readonly text: string; readonly hint?: string; retry?: boolean }> = {
  MIXED_CONTENT: reasonOf('MIXED_CONTENT', { hint: 'MIXED_CONTENT_HINT' }),
  UNTRUSTED_CERT: reasonOf('UNTRUSTED_CERT'),
  FRAME_ANCESTORS_MISSING: reasonOf('FRAME_ANCESTORS_MISSING'),
  X_FRAME_OPTIONS: reasonOf('X_FRAME_OPTIONS'),
  UNREACHABLE: reasonOf('UNREACHABLE', { retry: true }),
};

const ENTRY_TEXT: Readonly<Record<string, string>> = WP.entry;
const PREVIEW_STATES = ['READY', 'RUNNING', 'EXPIRING', 'KEPT'];

/** Entry names come from the dictionary (current language); the API's `label` is its zh-CN default, kept for unknown ids. */
export function entryLabel(t: PreviewTarget): string {
  return `${ENTRY_TEXT[t.id] ?? t.label ?? t.id} · ${redact(t.url)}`;
}

function joinPath(base: string, path: string): string {
  try {
    const u = new URL(base);
    const p = path.startsWith('/') ? path : `/${path}`;
    return `${u.origin}${p}`;
  } catch {
    return base;
  }
}

export function PreviewFrame({ active, narrow }: { active: boolean; narrow: boolean }) {
  const ws = useWorkspace();
  const { api } = useServices();
  const allowed = PREVIEW_STATES.includes(ws.view.state);
  // 懒加载：第一次打开预览标签时才请求；之后每 60 秒刷新
  const [touched, setTouched] = useState(active);
  useEffect(() => {
    if (active) setTouched(true);
  }, [active]);
  const pv = useResource<PreviewView>(touched && allowed ? `pv:${ws.sid}` : null, () => api.get<PreviewView>('getPreview', { params: { sid: ws.sid } }), { intervalMs: 60_000 });
  const key = `atl.ws.preview.${ws.sid}.v1`;
  const [sel, setSel] = useState<string | null>(() => ssGet<string | null>(key, null));
  const [path, setPath] = useState('/');
  const [vp, setVp] = useState<'375' | '768' | 'auto'>('auto');
  const [nonce, setNonce] = useState(0);
  const [cred, setCred] = useState(false);
  const targets = useMemo(() => pv.data?.targets ?? [], [pv.data]);
  const t = useMemo(() => targets.find((x) => x.id === sel) ?? targets.find((x) => x.id === pv.data?.default) ?? targets.find((x) => x.embeddable) ?? targets[0] ?? null, [targets, sel, pv.data?.default]);
  const reported = useRef<string | null>(null);
  useEffect(() => {
    if (!t || !active || reported.current === `${t.id}:${t.embeddable}`) return;
    reported.current = `${t.id}:${t.embeddable}`;
    ws.reporter?.push('workspace.preview_opened', { targetId: t.id, embedded: t.embeddable && !narrow });
  }, [t, active, narrow, ws.reporter]);

  if (!allowed) return <div className="empty pv-empty">{WP.unavailable}</div>;
  if (!touched || (pv.loading && !pv.data)) return <Skeleton lines={3} />;
  if (!t) return <div className="empty pv-empty">{pv.error ? WP.loadFailed : WP.noEntry}</div>;
  const url = joinPath(t.url, path);
  const reason = t.embeddable ? null : (REASON_TEXT[t.reason ?? ''] ?? { text: WP.notEmbeddable });
  const embed = t.embeddable && !narrow;
  const openNew = () => {
    window.open(url, '_blank', 'noopener,noreferrer');
    ws.reporter?.push('workspace.preview_opened', { targetId: t.id, embedded: false });
  };
  return (
    <div className="pv" data-preview={t.id}>
      <div className="pvbar row">
        <label className="small muted" htmlFor="pv-entry">
          {WP.entryLabel}
        </label>
        <select
          id="pv-entry"
          className="input"
          value={t.id}
          onChange={(e) => {
            setSel(e.target.value);
            ssSet(key, e.target.value);
            setNonce((n) => n + 1);
          }}
        >
          {targets.map((x) => (
            <option key={x.id} value={x.id}>
              {entryLabel(x)} {x.embeddable ? WP.embeddable : WP.newTabOnly}
            </option>
          ))}
        </select>
        <label className="sr" htmlFor="pv-path">
          {WP.path}
        </label>
        <input id="pv-path" className="input mono pvpath" value={path} onChange={(e) => setPath(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && setNonce((n) => n + 1)} />
        {embed ? (
          <button type="button" className="btn sm icon" aria-label={WP.refresh} onClick={() => setNonce((n) => n + 1)}>
            <Icon name="refresh" />
          </button>
        ) : null}
        <Button size="sm" icon="ext" onClick={openNew}>
          {WP.newTab}
        </Button>
        {embed ? (
          <div className="seg" role="group" aria-label={WP.viewport}>
            {(['375', '768', 'auto'] as const).map((v) => (
              <button key={v} type="button" aria-pressed={vp === v} onClick={() => setVp(v)}>
                {v === 'auto' ? WP.auto : v}
              </button>
            ))}
          </div>
        ) : null}
        {ws.learner ? (
          <Button size="sm" icon="key" onClick={() => setCred(true)}>
            {WP.adminAccount}
          </Button>
        ) : null}
      </div>
      {embed ? (
        <>
          <div className={`preview-frame vp-${vp}`}>
            <iframe
              key={`${t.id}-${nonce}`}
              src={url}
              title={tr(WP.frameTitle, { entry: ENTRY_TEXT[t.id] ?? t.label ?? t.id })}
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads"
              allow="clipboard-write"
              referrerPolicy="no-referrer"
              loading="lazy"
            />
          </div>
          <p className="small muted pvnote">{WP.loginNote}</p>
        </>
      ) : (
        <div className="empty pv-empty" data-reason={t.reason ?? (narrow ? 'NARROW' : '')}>
          <b>{narrow && t.embeddable ? WP.narrow : WP.cannotPreview}</b>
          {reason ? <span>{reason.text}</span> : null}
          {reason?.hint ? <span className="small">{reason.hint}</span> : null}
          <div className="row">
            {reason?.retry ? (
              <Button size="sm" icon="refresh" onClick={() => void pv.refresh()}>
                {WP.retry}
              </Button>
            ) : null}
            <Button size="sm" variant="primary" icon="ext" onClick={openNew}>
              {WP.openNewTab}
            </Button>
          </div>
        </div>
      )}
      {cred ? <CredentialRevealDialog onClose={() => setCred(false)} /> : null}
    </div>
  );
}

/** CloudAlbum 管理员账号（08 §5.3 CredentialRevealDialog）：密码默认遮盖，[显示 10 秒] [复制]；关闭即从内存清除。 */
export function CredentialRevealDialog({ onClose }: { onClose: () => void }) {
  const ws = useWorkspace();
  const { api } = useServices();
  const [c, setC] = useState<AppCredentials | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    let alive = true;
    api
      .call<AppCredentials>('getAppCredentials', { params: { sid: ws.sid }, conditional: false })
      .then((r) => alive && setC(r.data))
      .catch((e) => alive && setError(isApiError(e) ? (e.code === 'REAUTH_REQUIRED' ? WP.reauth : e.code === 'NOT_IMPLEMENTED' ? WP.notImplemented : (e.detail ?? e.title)) : WP.readFailed));
    return () => {
      alive = false;
      setC(null);
    };
  }, [api, ws.sid]);
  useEffect(() => {
    if (!shown) return undefined;
    const t = setTimeout(() => setShown(false), 10_000);
    return () => clearTimeout(t);
  }, [shown]);
  return (
    <Dialog
      open
      onClose={onClose}
      title={WP.credTitle}
      size="narrow"
      footer={
        <button type="button" className="btn" onClick={onClose}>
          {WP.close}
        </button>
      }
    >
      {error ? (
        <p className="small st fail" role="alert">
          {error}
        </p>
      ) : !c ? (
        <Skeleton lines={2} />
      ) : (
        <div className="stack-8">
          <dl className="kv">
            <dt>{WP.username}</dt>
            <dd className="mono">{c.username}</dd>
            <dt>{WP.password}</dt>
            <dd className="mono" aria-live="polite">
              {shown ? c.password : '••••••••'}
            </dd>
          </dl>
          <div className="row">
            <Button size="sm" icon="eye" onClick={() => setShown(true)} disabled={shown}>
              {WP.show10s}
            </Button>
            <Button
              size="sm"
              icon="copy"
              onClick={async () => {
                if (await copyText(c.password)) announce(WP.copiedPassword);
                else announce(WP.clipboardDenied);
              }}
            >
              {WP.copy}
            </Button>
          </div>
          <div className="note">
            <Shape name="dot" />
            <span>{WP.passwordNote}</span>
          </div>
        </div>
      )}
    </Dialog>
  );
}
