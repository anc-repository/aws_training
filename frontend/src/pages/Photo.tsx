// 照片详情（F5–F11）：大图、处理状态（PROCESSING 时按退避间隔轮询）、存储 / 缩略图 / 标签 / 编排徽章、点赞评论、分享链接。
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { describeError } from '../api/client';
import { albumsApi, photosApi } from '../api/endpoints';
import type { Comment, Photo as PhotoT, PhotoCounters, ShareLink, Visibility } from '../api/types';
import { useAuth } from '../auth/context';
import { badgeFor, processedByText, TONE_CLASS } from '../capabilities/badges';
import { ModuleBadge } from '../capabilities/ModuleBadge';
import { badgesOf } from '../capabilities/registry';
import { useCaps, useRegistry, useSocialApi } from '../capabilities/useCapability';
import { CdnBadge } from '../components/PhotoTile';
import { useAsync } from '../hooks/useAsync';
import { usePrefs } from '../prefs';
import { latestTrace, useTraces } from '../trace/TraceStore';
import { pollUntilSettled } from '../upload';
import { fmtBytes, fmtTime, timeAgo } from '../util/format';

export function PhotoPage() {
  const { id = '' } = useParams();
  const load = useCallback(() => photosApi.get(id), [id]);
  const photo = useAsync(load);
  const { setData } = photo;
  const current = photo.data;

  // 处理中：GET /api/photos/:id 按退避间隔轮询（1s 起，最长 5s）
  useEffect(() => {
    if (!current || (current.status !== 'PROCESSING' && current.status !== 'UPLOADING')) return undefined;
    const ctrl = new AbortController();
    void pollUntilSettled(current, { signal: ctrl.signal, onUpdate: (p) => { if (!ctrl.signal.aborted) setData(p); } }).catch(() => undefined);
    return () => ctrl.abort();
  }, [current, setData]);

  if (photo.loading && !current) return <div className="skeleton" style={{ height: 360 }} />;
  if (photo.error) return <p className="notice notice-error" role="alert">{photo.error}</p>;
  if (!current) return null;
  return <PhotoView photo={current} onChange={(p) => setData(p)} />;
}

function PhotoView({ photo, onChange }: { photo: PhotoT; onChange: (p: PhotoT) => void }) {
  const auth = useAuth();
  const caps = useCaps();
  const registry = useRegistry();
  const prefs = usePrefs();
  const navigate = useNavigate();
  const { entries } = useTraces();
  const mine = auth.user?.id === photo.ownerId;
  const last = latestTrace(entries, 'GET', '/api/photos/:id');
  const cdnSeg = last?.path.modules.find((m) => m.module === 'cdn');
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const remove = async () => {
    if (!globalThis.confirm?.('删除这张照片？原图与缩略图都会被删除。')) return;
    try {
      await photosApi.remove(photo.id);
      navigate('/');
    } catch (e) {
      setError(describeError(e));
    }
  };

  const src = photo.urls.display ?? photo.urls.thumb ?? null;
  const labelSource = photo.labels?.[0]?.source;
  const taggingBadges = badgesOf(registry, 'tagging');
  const workflowCap = caps.modules.workflow;

  return (
    <>
      <div className="page-head">
        <div className="stack" style={{ gap: 4 }}>
          <h1>{photo.title || photo.filename || '照片'}</h1>
          <span className="subtle">{photo.ownerName ? `${photo.ownerName} · ` : ''}{timeAgo(photo.createdAt)} · {photo.visibility === 'public' ? '公开' : '私有'}</span>
        </div>
        {mine && (
          <div className="row">
            <button type="button" className="btn" onClick={() => setEditing((v) => !v)}>{editing ? '取消' : '编辑'}</button>
            <button type="button" className="btn btn-danger" onClick={() => void remove()}>删除</button>
          </div>
        )}
      </div>
      {error && <p className="notice notice-error" role="alert">{error}</p>}
      <div className="photo-layout">
        <div className="stack">
          <div className="photo-stage">
            {photo.status === 'READY' && src ? (
              <img src={src} alt={photo.title || photo.filename} />
            ) : (
              <div className="stack" style={{ alignItems: 'center', padding: 32 }}>
                <span className={photo.status === 'FAILED' || photo.status === 'BLOCKED' ? 'status-err' : 'muted'}>
                  {photo.status === 'PROCESSING' ? '缩略图生成中…（每隔几秒自动刷新）' : photo.status === 'UPLOADING' ? '等待上传完成…' : photo.status === 'BLOCKED' ? '照片已被屏蔽' : `处理失败：${photo.failureReason ?? '未知原因'}`}
                </span>
              </div>
            )}
          </div>
          {photo.caption && <p>{photo.caption}</p>}
          {editing && mine && <EditPhoto photo={photo} onSaved={(p) => { onChange(p); setEditing(false); }} />}
          <Social photo={photo} />
        </div>
        <aside className="stack">
          <div className="card stack">
            <h2 style={{ marginTop: 0 }}>这张照片由谁提供</h2>
            {prefs.showBadges ? (
              <div className="stack" style={{ gap: 6 }}>
                <div className="row"><span className="subtle" style={{ width: 56 }}>图片</span>{photo.status === 'READY' && <CdnBadge url={src} outcome={cdnSeg?.outcome === 'bypass' ? 'bypass' : undefined} />}</div>
                <div className="row"><span className="subtle" style={{ width: 56 }}>存储</span><ModuleBadge module={caps.modules['shared-fs']?.status !== 'off' ? 'shared-fs' : 'storage'} /></div>
                {photo.processedBy && (
                  <div className="row">
                    <span className="subtle" style={{ width: 56 }}>缩略图</span>
                    <StaticBadge {...processedByText(registry, photo.processedBy)} title={`host ${photo.processedBy.host ?? '—'}`} />
                  </div>
                )}
                {labelSource && (
                  <div className="row">
                    <span className="subtle" style={{ width: 56 }}>标签</span>
                    <StaticBadge
                      text={labelSource === 'rekognition' ? (taggingBadges['aws'] ?? '标签来自 Amazon Rekognition') : (taggingBadges['local'] ?? '基础属性标签（本地）')}
                      tone={labelSource === 'rekognition' ? 'aws' : 'local'}
                    />
                  </div>
                )}
                {workflowCap && (
                  <div className="row">
                    <span className="subtle" style={{ width: 56 }}>流程</span>
                    <StaticBadge
                      {...badgeFor('workflow', workflowCap, registry)}
                      text={`${badgeFor('workflow', workflowCap, registry).text}${photo.workflow?.executionId ? ` · ${photo.workflow.executionId.slice(-12)}` : ''}${photo.workflow?.attempts ? ` · 重试 ${photo.workflow.attempts}` : ''}`}
                    />
                  </div>
                )}
              </div>
            ) : <p className="subtle">已在用户菜单中关闭“显示架构徽章”。</p>}
            <dl className="kv">
              <dt>状态</dt><dd>{photo.status}</dd>
              <dt>尺寸</dt><dd className="num">{photo.width && photo.height ? `${photo.width}×${photo.height}` : '—'}</dd>
              <dt>大小</dt><dd className="num">{fmtBytes(photo.sizeBytes)}</dd>
              <dt>类型</dt><dd className="mono">{photo.contentType}</dd>
              <dt>上传</dt><dd>{fmtTime(photo.createdAt)}</dd>
              <dt>就绪</dt><dd>{fmtTime(photo.readyAt)}</dd>
              {photo.takenAt && (<><dt>拍摄</dt><dd>{fmtTime(photo.takenAt)}</dd></>)}
              {photo.albumId && (<><dt>相册</dt><dd><Link to={`/albums/${photo.albumId}`}>打开相册</Link></dd></>)}
            </dl>
            {photo.labels && photo.labels.length > 0 && (
              <div className="chips">
                {photo.labels.map((l) => (
                  <span key={`${l.source}-${l.name}`} className="chip chip-local" title={`${l.source} · ${(l.confidence * (l.confidence <= 1 ? 100 : 1)).toFixed(0)}%`}>{l.name}</span>
                ))}
              </div>
            )}
          </div>
          {photo.status === 'READY' && auth.user && !auth.user.restricted && <SharePanel photo={photo} />}
        </aside>
      </div>
    </>
  );
}

function StaticBadge({ text, tone, title }: { text: string; tone: keyof typeof TONE_CLASS; title?: string }) {
  return <span className={`badge badge-${TONE_CLASS[tone]}`} title={title}>{text}</span>;
}

function EditPhoto({ photo, onSaved }: { photo: PhotoT; onSaved: (p: PhotoT) => void }) {
  const [title, setTitle] = useState(photo.title ?? '');
  const [caption, setCaption] = useState(photo.caption ?? '');
  const [visibility, setVisibility] = useState<Visibility>(photo.visibility);
  const [albumId, setAlbumId] = useState(photo.albumId ?? '');
  const loadAlbums = useCallback(() => albumsApi.list(), []);
  const albums = useAsync(loadAlbums);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      onSaved(await photosApi.update(photo.id, { title, caption, visibility, albumId: albumId || null }));
    } catch (err) {
      setError(describeError(err));
    }
  };
  return (
    <form className="card" onSubmit={(e) => void submit(e)}>
      <div className="field"><label htmlFor="ep-title">标题</label><input id="ep-title" className="input" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} /></div>
      <div className="field"><label htmlFor="ep-cap">说明</label><textarea id="ep-cap" className="input" value={caption} onChange={(e) => setCaption(e.target.value)} /></div>
      <div className="row">
        <div className="field" style={{ flex: 1 }}>
          <label htmlFor="ep-album">相册</label>
          <select id="ep-album" className="input" value={albumId} onChange={(e) => setAlbumId(e.target.value)}>
            <option value="">（不在相册中）</option>
            {albums.data?.items.map((a) => <option key={a.id} value={a.id}>{a.title}</option>)}
          </select>
        </div>
        <div className="field" style={{ flex: 1 }}>
          <label htmlFor="ep-vis">可见性</label>
          <select id="ep-vis" className="input" value={visibility} onChange={(e) => setVisibility(e.target.value as Visibility)}>
            <option value="private">私有</option>
            <option value="public">公开</option>
          </select>
        </div>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      <button type="submit" className="btn btn-primary">保存</button>
    </form>
  );
}

// ------------------------------------------------------------------------------------------ 点赞与评论（F9）
function Social({ photo }: { photo: PhotoT }) {
  const social = useSocialApi();
  const auth = useAuth();
  const [counters, setCounters] = useState<PhotoCounters | null>(photo.counters ? { ...photo.counters, likedByMe: Boolean(photo.likedByMe) } : null);
  const loadComments = useCallback(() => social.comments(photo.id), [social, photo.id]);
  const comments = useAsync(loadComments);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    social.counters(photo.id).then((c) => { if (!cancelled) setCounters(c); }, () => undefined);
    return () => { cancelled = true; };
  }, [social, photo.id]);

  const toggleLike = async () => {
    if (!auth.user) return;
    try {
      setCounters(counters?.likedByMe ? await social.unlike(photo.id, counters) : await social.like(photo.id, counters));
    } catch (e) {
      setError(describeError(e));
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const c = await social.addComment(photo.id, text.trim());
      comments.setData((cur) => ({ items: [...(cur?.items ?? []), c], nextCursor: cur?.nextCursor ?? null }));
      setCounters((cur) => (cur ? { ...cur, comments: cur.comments + 1 } : cur));
      setText('');
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (c: Comment) => {
    try {
      await social.deleteComment(photo.id, c.id);
      comments.setData((cur) => (cur ? { ...cur, items: cur.items.filter((x) => x.id !== c.id) } : cur));
      setCounters((cur) => (cur ? { ...cur, comments: Math.max(0, cur.comments - 1) } : cur));
    } catch (err) {
      setError(describeError(err));
    }
  };

  return (
    <section className="card stack" aria-label="点赞与评论">
      <div className="row spread">
        <div className="row">
          <button type="button" className={`btn ${counters?.likedByMe ? 'btn-primary' : ''}`} disabled={!auth.user || auth.user.restricted} onClick={() => void toggleLike()} aria-pressed={Boolean(counters?.likedByMe)}>
            {counters?.likedByMe ? '已赞' : '点赞'} · <span className="num">{counters?.likes ?? 0}</span>
          </button>
          <span className="subtle num">{counters?.comments ?? comments.data?.items.length ?? 0} 条评论</span>
        </div>
        <div className="row">
          <ModuleBadge module="social-store" />
          <ModuleBadge module="social-api" />
        </div>
      </div>
      {comments.loading && !comments.data && <div className="skeleton" style={{ height: 48 }} />}
      {comments.error && <p className="notice notice-error">{comments.error}</p>}
      <div>
        {comments.data?.items.map((c) => (
          <div key={c.id} className="comment">
            <div className="row spread">
              <strong>{c.userName ?? c.userId.slice(0, 8)}</strong>
              <span className="subtle">{timeAgo(c.createdAt)}</span>
            </div>
            <p style={{ whiteSpace: 'pre-wrap', margin: '2px 0 0' }}>{c.text}</p>
            {(c.mine || auth.user?.id === c.userId || auth.isAdmin) && (
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => void remove(c)}>删除</button>
            )}
          </div>
        ))}
      </div>
      {auth.user && !auth.user.restricted ? (
        <form onSubmit={(e) => void submit(e)} className="stack">
          <label className="visually-hidden" htmlFor="comment-text">写评论</label>
          <textarea id="comment-text" className="input" placeholder="写评论…（照片主人会收到通知）" value={text} onChange={(e) => setText(e.target.value)} maxLength={2000} />
          {error && <p className="form-error" role="alert">{error}</p>}
          <div><button type="submit" className="btn btn-primary" disabled={busy || !text.trim()}>{busy ? '发送中…' : '发表评论'}</button></div>
        </form>
      ) : (
        <p className="subtle"><Link to="/login">登录</Link>后可以点赞和评论。</p>
      )}
    </section>
  );
}

// ------------------------------------------------------------------------------------------ 分享链接（F11）
const TTL_OPTIONS = [
  { sec: 3600, label: '1 小时' },
  { sec: 86400, label: '1 天' },
  { sec: 7 * 86400, label: '7 天' },
];

function SharePanel({ photo }: { photo: PhotoT }) {
  const social = useSocialApi();
  const [ttl, setTtl] = useState(86400);
  const [link, setLink] = useState<ShareLink | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const create = async () => {
    setError(null);
    setCopied(false);
    try {
      setLink(await social.createShare(photo.id, ttl));
    } catch (e) {
      setError(describeError(e));
    }
  };
  const url = link ? (link.url || `${globalThis.location?.origin ?? ''}/s/${link.token}`) : '';
  const copy = async () => {
    try {
      await globalThis.navigator?.clipboard?.writeText(url);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="card stack">
      <h2 style={{ marginTop: 0 }}>分享链接</h2>
      <p className="subtle">带有效期的只读链接；过期后由 share.cleanup 定时任务清理（DynamoDB 档由 TTL 回收）。</p>
      <div className="row">
        <label className="visually-hidden" htmlFor="share-ttl">有效期</label>
        <select id="share-ttl" className="input" style={{ width: 'auto' }} value={ttl} onChange={(e) => setTtl(Number(e.target.value))}>
          {TTL_OPTIONS.map((o) => <option key={o.sec} value={o.sec}>{o.label}</option>)}
        </select>
        <button type="button" className="btn" onClick={() => void create()}>生成链接</button>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      {link && (
        <div className="stack">
          <input className="input mono" readOnly value={url} aria-label="分享链接" onFocus={(e) => e.currentTarget.select()} />
          <div className="row">
            <button type="button" className="btn btn-sm" onClick={() => void copy()}>{copied ? '已复制' : '复制'}</button>
            <span className="subtle">有效期至 {fmtTime(link.expiresAt)}</span>
          </div>
        </div>
      )}
    </div>
  );
}
