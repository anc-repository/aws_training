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

export const REASON_TEXT: Record<string, { text: string; hint?: string; retry?: boolean }> = {
  MIXED_CONTENT: {
    text: '当前入口只有 HTTP，嵌入会被浏览器作为混合内容拦截。本卡片从自签名 / ALB 的 HTTP 入口讲起时，预览在新标签页打开。',
    hint: '如何在此处直接预览：使用受信任 HTTPS 的入口，例如启用 cdn 后改用 CloudFront 入口。',
  },
  UNTRUSTED_CERT: { text: '入口的证书不受浏览器信任（例如自签名），无法嵌入。不建议在新标签页中忽略证书警告。' },
  FRAME_ANCESTORS_MISSING: { text: '应用没有允许平台嵌入（CSP frame-ancestors）。' },
  X_FRAME_OPTIONS: { text: '应用没有允许平台嵌入（X-Frame-Options）。' },
  UNREACHABLE: { text: '入口暂时无法访问（实例停止、安全组收紧或换 IP 演练期间）。', retry: true },
};

const ENTRY_TEXT: Record<string, string> = { direct: '直连 EC2', app: '应用入口', cdn: 'CloudFront', alb: '负载均衡器', 'custom-domain': '自定义域名' };
const PREVIEW_STATES = ['READY', 'RUNNING', 'EXPIRING', 'KEPT'];

export function entryLabel(t: PreviewTarget): string {
  return `${t.label ?? ENTRY_TEXT[t.id] ?? t.id} · ${redact(t.url)}`;
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

  if (!allowed) return <div className="empty pv-empty">预览不可用：环境已停止或已释放。</div>;
  if (!touched || (pv.loading && !pv.data)) return <Skeleton lines={3} />;
  if (!t) return <div className="empty pv-empty">{pv.error ? '读取预览入口失败。' : '还没有可用的应用入口。'}</div>;
  const url = joinPath(t.url, path);
  const reason = t.embeddable ? null : (REASON_TEXT[t.reason ?? ''] ?? { text: '这个入口不能嵌入预览。' });
  const embed = t.embeddable && !narrow;
  const openNew = () => {
    window.open(url, '_blank', 'noopener,noreferrer');
    ws.reporter?.push('workspace.preview_opened', { targetId: t.id, embedded: false });
  };
  return (
    <div className="pv" data-preview={t.id}>
      <div className="pvbar row">
        <label className="small muted" htmlFor="pv-entry">
          入口
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
              {entryLabel(x)} {x.embeddable ? '✓ 可嵌入' : '✕ 仅新标签页'}
            </option>
          ))}
        </select>
        <label className="sr" htmlFor="pv-path">
          路径
        </label>
        <input id="pv-path" className="input mono pvpath" value={path} onChange={(e) => setPath(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && setNonce((n) => n + 1)} />
        {embed ? (
          <button type="button" className="btn sm icon" aria-label="刷新预览" onClick={() => setNonce((n) => n + 1)}>
            <Icon name="refresh" />
          </button>
        ) : null}
        <Button size="sm" icon="ext" onClick={openNew}>
          新标签页
        </Button>
        {embed ? (
          <div className="seg" role="group" aria-label="视口宽度">
            {(['375', '768', 'auto'] as const).map((v) => (
              <button key={v} type="button" aria-pressed={vp === v} onClick={() => setVp(v)}>
                {v === 'auto' ? '自适应' : v}
              </button>
            ))}
          </div>
        ) : null}
        {ws.learner ? (
          <Button size="sm" icon="key" onClick={() => setCred(true)}>
            管理员账号
          </Button>
        ) : null}
      </div>
      {embed ? (
        <>
          <div className={`preview-frame vp-${vp}`}>
            <iframe
              key={`${t.id}-${nonce}`}
              src={url}
              title={`CloudAlbum 应用预览（${t.label ?? ENTRY_TEXT[t.id] ?? t.id}）`}
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads"
              allow="clipboard-write"
              referrerPolicy="no-referrer"
              loading="lazy"
            />
          </div>
          <p className="small muted pvnote">预览框内与新标签页中的 CloudAlbum 登录状态互相独立；部分浏览器（含部分 Safari 版本）在预览框内无法保持登录，请改用新标签页。</p>
        </>
      ) : (
        <div className="empty pv-empty" data-reason={t.reason ?? (narrow ? 'NARROW' : '')}>
          <b>{narrow && t.embeddable ? '窄屏下预览在新标签页打开' : '无法在此处预览'}</b>
          {reason ? <span>{reason.text}</span> : null}
          {reason?.hint ? <span className="small">{reason.hint}</span> : null}
          <div className="row">
            {reason?.retry ? (
              <Button size="sm" icon="refresh" onClick={() => void pv.refresh()}>
                重试
              </Button>
            ) : null}
            <Button size="sm" variant="primary" icon="ext" onClick={openNew}>
              在新标签页打开
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
      .catch((e) => alive && setError(isApiError(e) ? (e.code === 'REAUTH_REQUIRED' ? '查看管理员密码要求最近 60 分钟内登录过。' : e.code === 'NOT_IMPLEMENTED' ? '平台暂时不能提供管理员账号。' : (e.detail ?? e.title)) : '读取失败'));
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
    <Dialog open onClose={onClose} title="CloudAlbum 管理员账号" size="narrow" footer={<button type="button" className="btn" onClick={onClose}>关闭</button>}>
      {error ? (
        <p className="small st fail" role="alert">
          {error}
        </p>
      ) : !c ? (
        <Skeleton lines={2} />
      ) : (
        <div className="stack-8">
          <dl className="kv">
            <dt>用户名</dt>
            <dd className="mono">{c.username}</dd>
            <dt>初始密码</dt>
            <dd className="mono" aria-live="polite">
              {shown ? c.password : '••••••••'}
            </dd>
          </dl>
          <div className="row">
            <Button size="sm" icon="eye" onClick={() => setShown(true)} disabled={shown}>
              显示 10 秒
            </Button>
            <Button
              size="sm"
              icon="copy"
              onClick={async () => {
                if (await copyText(c.password)) announce('已复制密码');
                else announce('无法访问剪贴板');
              }}
            >
              复制
            </Button>
          </div>
          <div className="note">
            <Shape name="dot" />
            <span>密码只在这个对话框中显示，关闭后从页面内存中清除。</span>
          </div>
        </div>
      )}
    </Dialog>
  );
}
