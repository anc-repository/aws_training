// 上传（F6 / F14）：按 capabilities 自动选择策略；每张照片一条阶段时间线（建档 → 上传 → 完成 → 处理中 → 就绪 / 失败）。
// 上传按钮旁的徽章说明“这次上传由谁提供”：storage（上传到 EC2 / 直传 S3）与 identity-pool（应用自签令牌 / STS 临时凭证）。
import { useCallback, useMemo, useRef, useState, type ChangeEvent, type DragEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { describeError } from '../api/client';
import { albumsApi } from '../api/endpoints';
import type { Photo } from '../api/types';
import { ModuleBadge } from '../capabilities/ModuleBadge';
import { processedByText, TONE_CLASS } from '../capabilities/badges';
import { useCaps, useRegistry } from '../capabilities/useCapability';
import { useAsync } from '../hooks/useAsync';
import { PathChips } from '../trace/PathChips';
import { getTraceSnapshot, type TraceEntry } from '../trace/TraceStore';
import { chooseStrategy, pollUntilSettled, uploadFile, type UploadPreference } from '../upload';
import type { ResumeState, UploadStage, UploadStrategyId } from '../upload/types';
import { fmtBytes } from '../util/format';

interface Item {
  key: string;
  file: File;
  stage: UploadStage;
  loaded: number;
  photo?: Photo;
  error?: string;
  resume?: ResumeState;
  strategy: UploadStrategyId;
  completeTrace?: TraceEntry;
}

const STAGES: Array<{ id: UploadStage; label: string }> = [
  { id: 'create', label: '建档' },
  { id: 'upload', label: '上传' },
  { id: 'complete', label: '完成' },
  { id: 'processing', label: '处理中' },
  { id: 'ready', label: '就绪' },
];

const STRATEGY_LABEL: Record<UploadStrategyId, string> = {
  'signed-url': '逐文件签名 URL（F6）',
  'prefix-token': '多文件分片直传 · 应用自签前缀令牌（F14）',
  'identity-pool': '多文件分片直传 · STS 临时凭证（F14）',
};

const CONCURRENCY = 2;
/** 与 packages/image-core 的 ACCEPTED_TYPES 一致（服务端还会校验文件头） */
const ACCEPTED = ['image/jpeg', 'image/png', 'image/webp'];

export function UploadPage() {
  const caps = useCaps();
  const registry = useRegistry();
  const [params] = useSearchParams();
  const loadAlbums = useCallback(() => albumsApi.list(), []);
  const albums = useAsync(loadAlbums);
  const [albumId, setAlbumId] = useState(params.get('album') ?? '');
  const [pref, setPref] = useState<UploadPreference>('auto');
  const [items, setItems] = useState<Item[]>([]);
  const [drag, setDrag] = useState(false);
  const [rejected, setRejected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const running = useRef(0);
  const queue = useRef<string[]>([]);
  const itemsRef = useRef<Item[]>([]);
  itemsRef.current = items;

  const f14 = caps.features['F14.directUpload'];
  const storageCap = caps.modules.storage;
  const uploadDisabled = storageCap?.status === 'error';
  const preview = useMemo(() => chooseStrategy(caps, items.length ? items.map((i) => i.file) : [{ size: 0 }], pref), [caps, items, pref]);

  const patch = useCallback((key: string, p: Partial<Item>) => {
    setItems((cur) => cur.map((it) => (it.key === key ? { ...it, ...p } : it)));
  }, []);

  const runOne = useCallback(async (key: string) => {
    const it = itemsRef.current.find((x) => x.key === key);
    if (!it) return;
    patch(key, { error: undefined, stage: it.resume ? 'upload' : 'create' } as Partial<Item>);
    try {
      const photo = await uploadFile(it.file, it.strategy, {
        albumId: albumId || null,
        onStage: (stage) => patch(key, { stage }),
        onProgress: (loaded) => patch(key, { loaded }),
        onCreated: (p) => patch(key, { photo: p }),
        onResumeState: (s) => patch(key, { resume: { ...s, done: { ...s.done } } }),
        ...(it.resume ? { resume: it.resume } : {}),
      });
      const completeTrace = getTraceSnapshot().entries.find((e) => e.method === 'POST' && e.url.includes(`/api/photos/${photo.id}/complete`));
      patch(key, { photo, ...(completeTrace ? { completeTrace } : {}), stage: photo.status === 'READY' ? 'ready' : photo.status === 'FAILED' || photo.status === 'BLOCKED' ? 'failed' : 'processing' });
      if (photo.status === 'PROCESSING' || photo.status === 'UPLOADING') {
        const done = await pollUntilSettled(photo, { onUpdate: (p) => patch(key, { photo: p }) });
        patch(key, { photo: done, stage: done.status === 'READY' ? 'ready' : done.status === 'PROCESSING' ? 'processing' : 'failed' });
      }
    } catch (e) {
      patch(key, { stage: 'failed', error: describeError(e) });
    }
  }, [albumId, patch]);

  const pump = useCallback(() => {
    while (running.current < CONCURRENCY && queue.current.length) {
      const key = queue.current.shift()!;
      running.current += 1;
      void runOne(key).finally(() => {
        running.current -= 1;
        pump();
      });
    }
  }, [runOne]);

  const addFiles = (files: FileList | File[]) => {
    const all = [...files];
    const list = all.filter((f) => ACCEPTED.includes(f.type) || (!f.type && /\.(jpe?g|png|webp)$/i.test(f.name)));
    setRejected(all.length - list.length);
    if (!list.length) return;
    const choice = chooseStrategy(caps, list, pref);
    const next: Item[] = list.map((file, i) => ({
      key: `${Date.now()}-${i}-${file.name}`,
      file,
      stage: 'create',
      loaded: 0,
      strategy: choice.id,
    }));
    setItems((cur) => [...next, ...cur]);
    itemsRef.current = [...next, ...itemsRef.current];
    queue.current.push(...next.map((n) => n.key));
    pump();
  };

  const onPick = (e: ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) addFiles(e.target.files);
    e.target.value = '';
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDrag(false);
    if (e.dataTransfer.files) addFiles(e.dataTransfer.files);
  };
  const retry = (key: string) => {
    queue.current.push(key);
    pump();
  };

  return (
    <>
      <div className="page-head">
        <h1>上传照片</h1>
        <div className="row">
          <ModuleBadge module="storage" variant="upload" />
          <ModuleBadge module="identity-pool" />
          <ModuleBadge module="image-processing" />
        </div>
      </div>
      {uploadDisabled && <p className="notice notice-error" role="alert">存储故障，暂时无法上传：{storageCap?.detail}</p>}
      <div className="card stack" style={{ marginBottom: 16 }}>
        <div className="row">
          <div className="field" style={{ minWidth: 200, flex: 1 }}>
            <label htmlFor="up-album">上传到相册</label>
            <select id="up-album" className="input" value={albumId} onChange={(e) => setAlbumId(e.target.value)}>
              <option value="">默认相册</option>
              {albums.data?.items.map((a) => <option key={a.id} value={a.id}>{a.title}</option>)}
            </select>
          </div>
          <div className="field" style={{ minWidth: 200, flex: 1 }}>
            <label htmlFor="up-mode">上传方式</label>
            <select id="up-mode" className="input" value={pref} onChange={(e) => setPref(e.target.value as UploadPreference)}>
              <option value="auto">自动（按 capabilities 与文件数选择）</option>
              <option value="single">逐文件签名 URL（F6）</option>
              <option value="multi" disabled={f14?.enabled === false}>多文件分片直传（F14）</option>
            </select>
          </div>
        </div>
        <p className="subtle" style={{ margin: 0 }}>
          将使用：<strong>{STRATEGY_LABEL[preview.id]}</strong> · {preview.reason} · 由 <span className="mono">{preview.via.join(', ')}</span> 提供
          {f14?.detail ? ` · ${f14.detail}` : ''}
        </p>
        <div
          className={`dropzone ${drag ? 'drag' : ''}`}
          role="button"
          tabIndex={0}
          aria-disabled={uploadDisabled}
          onClick={() => !uploadDisabled && inputRef.current?.click()}
          onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && !uploadDisabled) inputRef.current?.click(); }}
          onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
          onDragLeave={() => setDrag(false)}
          onDrop={onDrop}
        >
          <strong>选择或拖入照片</strong>
          <p className="subtle" style={{ margin: '4px 0 0' }}>JPEG / PNG / WebP；可一次选择多张。上传上限由运行时配置 maxUploadMb 决定（服务端校验）。</p>
          <input ref={inputRef} type="file" accept={ACCEPTED.join(',')} multiple hidden onChange={onPick} data-testid="file-input" />
        </div>
        {rejected > 0 && <p className="form-error" role="alert">已忽略 {rejected} 个不支持的文件（只接受 JPEG / PNG / WebP）。</p>}
      </div>

      {items.length > 0 && (
        <ul className="list-plain card" aria-label="上传列表">
          {items.map((it) => {
            const pct = it.file.size ? Math.min(100, Math.round((it.loaded / it.file.size) * 100)) : 0;
            const failed = it.stage === 'failed';
            const stageIdx = STAGES.findIndex((s) => s.id === it.stage);
            return (
              <li key={it.key} className="stack" style={{ gap: 6 }}>
                <div className="row spread">
                  <strong className="wrap-any">{it.file.name}</strong>
                  <span className="subtle num">{fmtBytes(it.file.size)} · {STRATEGY_LABEL[it.strategy]}</span>
                </div>
                <div className="timeline-steps" aria-label="阶段">
                  {STAGES.map((s, i) => (
                    <span key={s.id} className={`step ${failed && i === Math.max(0, stageIdx) ? 'failed' : i < stageIdx || it.stage === 'ready' ? 'done' : i === stageIdx ? 'active' : ''}`}>{s.label}</span>
                  ))}
                  {failed && <span className="step failed">失败</span>}
                </div>
                {(it.stage === 'upload' || it.stage === 'create') && <div className="progress" aria-label="上传进度" aria-valuenow={pct}><span style={{ width: `${pct}%` }} /></div>}
                {it.error && (
                  <div className="row">
                    <span className="form-error" role="alert">{it.error}</span>
                    <button type="button" className="btn btn-sm" onClick={() => retry(it.key)}>{it.resume ? '续传' : '重试'}</button>
                  </div>
                )}
                {it.photo?.status === 'FAILED' && <span className="form-error">处理失败：{it.photo.failureReason ?? '未知原因'}</span>}
                {it.photo && (it.stage === 'ready' || it.stage === 'processing') && (
                  <div className="row">
                    <Link to={`/photos/${it.photo.id}`}>查看照片</Link>
                    {it.photo.processedBy && (() => {
                      const b = processedByText(registry, it.photo.processedBy);
                      return <span className={`badge badge-${TONE_CLASS[b.tone]}`}>{b.text}</span>;
                    })()}
                    {it.completeTrace && <PathChips path={it.completeTrace.path} caps={caps} showMeta={false} />}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
