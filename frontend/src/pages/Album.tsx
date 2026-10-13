// 相册（F5）：/albums 列表与新建；/albums/:id 详情（GET 走 dbRead 与 cache.wrap，可被 X-Compare-Bypass: cache / replica 旁路）。
import { useCallback, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { describeError } from '../api/client';
import { albumsApi } from '../api/endpoints';
import type { Album, Visibility } from '../api/types';
import { useAuth } from '../auth/context';
import { ModuleBadge } from '../capabilities/ModuleBadge';
import { PhotoGrid } from '../components/PhotoTile';
import { useAsync } from '../hooks/useAsync';
import { latestTrace, useTraces } from '../trace/TraceStore';
import { timeAgo } from '../util/format';

export function AlbumList() {
  const load = useCallback(() => albumsApi.list(), []);
  const albums = useAsync(load);
  const [showNew, setShowNew] = useState(false);
  return (
    <>
      <div className="page-head">
        <h1>我的相册</h1>
        <button type="button" className="btn btn-primary" onClick={() => setShowNew((v) => !v)}>{showNew ? '取消' : '新建相册'}</button>
      </div>
      {showNew && <NewAlbumForm onCreated={(a) => { albums.setData((cur) => ({ items: [a, ...(cur?.items ?? [])] })); setShowNew(false); }} />}
      {albums.loading && !albums.data && <div className="skeleton" style={{ height: 160 }} />}
      {albums.error && <p className="notice notice-error" role="alert">{albums.error}</p>}
      {albums.data && albums.data.items.length === 0 && <p className="muted">还没有相册。注册时会自动建一个默认相册（F2）。</p>}
      <div className="grid-albums">
        {albums.data?.items.map((a) => (
          <Link key={a.id} to={`/albums/${a.id}`} className="album-card">
            <div className="album-cover">{a.coverUrl ? <img src={a.coverUrl} alt="" loading="lazy" /> : <div className="placeholder-img" />}</div>
            <div className="album-body">
              <div className="row spread"><strong>{a.title}</strong>{a.isDefault && <span className="badge badge-gray badge-plain">默认</span>}</div>
              <div className="subtle">{a.photoCount ?? 0} 张 · {a.visibility === 'public' ? '公开' : '私有'} · {timeAgo(a.updatedAt)}</div>
            </div>
          </Link>
        ))}
      </div>
    </>
  );
}

function NewAlbumForm({ onCreated }: { onCreated: (a: Album) => void }) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [visibility, setVisibility] = useState<Visibility>('private');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    setBusy(true);
    setError(null);
    try {
      onCreated(await albumsApi.create({ title: title.trim(), description: description.trim(), visibility }));
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="card" onSubmit={(e) => void submit(e)} style={{ marginBottom: 16, maxWidth: 520 }}>
      <div className="field"><label htmlFor="al-title">标题</label><input id="al-title" className="input" value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} /></div>
      <div className="field"><label htmlFor="al-desc">描述</label><textarea id="al-desc" className="input" value={description} onChange={(e) => setDescription(e.target.value)} /></div>
      <div className="field">
        <label htmlFor="al-vis">可见性</label>
        <select id="al-vis" className="input" value={visibility} onChange={(e) => setVisibility(e.target.value as Visibility)}>
          <option value="private">私有</option>
          <option value="public">公开</option>
        </select>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? '创建中…' : '创建'}</button>
    </form>
  );
}

export function AlbumPage() {
  const { id = '' } = useParams();
  const auth = useAuth();
  const navigate = useNavigate();
  const load = useCallback(() => albumsApi.get(id), [id]);
  const album = useAsync(load);
  const { entries } = useTraces();
  const last = latestTrace(entries, 'GET', '/api/albums/:id');
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (album.loading && !album.data) return <div className="skeleton" style={{ height: 240 }} />;
  if (album.error) return <p className="notice notice-error" role="alert">{album.error}</p>;
  if (!album.data) return null;
  const a = album.data.album;
  const mine = auth.user?.id === a.ownerId;

  const remove = async () => {
    if (!globalThis.confirm?.(`删除相册“${a.title}”？相册里的照片不会被删除。`)) return;
    try {
      await albumsApi.remove(a.id);
      navigate('/albums');
    } catch (e) {
      setError(describeError(e));
    }
  };

  return (
    <>
      <div className="page-head">
        <div className="stack" style={{ gap: 4 }}>
          <h1>{a.title}</h1>
          <div className="row">
            <span className="subtle">{a.visibility === 'public' ? '公开' : '私有'} · {album.data.photos.length} 张</span>
            <ModuleBadge module="cache" outcome={last?.path.modules.find((m) => m.module === 'cache')?.outcome} />
          </div>
        </div>
        {mine && (
          <div className="row">
            <Link className="btn btn-primary" to={`/upload?album=${a.id}`}>上传到此相册</Link>
            <button type="button" className="btn" onClick={() => setEditing((v) => !v)}>{editing ? '取消' : '编辑'}</button>
            {!a.isDefault && <button type="button" className="btn btn-danger" onClick={() => void remove()}>删除</button>}
          </div>
        )}
      </div>
      {a.description && <p className="muted">{a.description}</p>}
      {error && <p className="notice notice-error" role="alert">{error}</p>}
      {editing && (
        <EditAlbum album={a} onSaved={(next) => { album.setData((cur) => (cur ? { ...cur, album: next } : cur)); setEditing(false); }} />
      )}
      {album.data.photos.length === 0 ? <p className="muted">相册里还没有照片。</p> : <PhotoGrid photos={album.data.photos} />}
    </>
  );
}

function EditAlbum({ album, onSaved }: { album: Album; onSaved: (a: Album) => void }) {
  const [title, setTitle] = useState(album.title);
  const [description, setDescription] = useState(album.description ?? '');
  const [visibility, setVisibility] = useState<Visibility>(album.visibility);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      onSaved(await albumsApi.update(album.id, { title, description, visibility }));
    } catch (err) {
      setError(describeError(err));
    }
  };
  return (
    <form className="card" onSubmit={(e) => void submit(e)} style={{ marginBottom: 16, maxWidth: 520 }}>
      <div className="field"><label htmlFor="ea-title">标题</label><input id="ea-title" className="input" value={title} onChange={(e) => setTitle(e.target.value)} required /></div>
      <div className="field"><label htmlFor="ea-desc">描述</label><textarea id="ea-desc" className="input" value={description} onChange={(e) => setDescription(e.target.value)} /></div>
      <div className="field">
        <label htmlFor="ea-vis">可见性</label>
        <select id="ea-vis" className="input" value={visibility} onChange={(e) => setVisibility(e.target.value as Visibility)}>
          <option value="private">私有</option>
          <option value="public">公开</option>
        </select>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      <button type="submit" className="btn btn-primary">保存</button>
    </form>
  );
}
