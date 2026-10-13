// 时间线（F5）：GET /api/feed。标题旁是请求级 cache 徽章（这一次是否命中缓存），右下角是性能徽章（DB 调用次数与耗时）。
// 管理员可以对同一接口再发一次带 X-Compare-Bypass: cache 的请求，在路径追踪抽屉里两两对比（§8.3 运行时 A/B）。
import { useCallback, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, describeError } from '../api/client';
import { photosApi, type FeedScope } from '../api/endpoints';
import type { Photo } from '../api/types';
import { useAuth } from '../auth/context';
import { ModuleBadge } from '../capabilities/ModuleBadge';
import { useCaps } from '../capabilities/useCapability';
import { PhotoGrid } from '../components/PhotoTile';
import { useAsync } from '../hooks/useAsync';
import { latestTrace, timingCount, useTraces } from '../trace/TraceStore';

export function Feed() {
  const auth = useAuth();
  const caps = useCaps();
  const signedIn = Boolean(auth.user && !auth.user.restricted);
  // null = 自动：已登录看“我的照片”，未登录看公开照片
  const [chosen, setScope] = useState<FeedScope | null>(null);
  const scope: FeedScope = chosen ?? (signedIn ? 'mine' : 'public');
  const effectiveScope: FeedScope = signedIn ? scope : 'public';
  const load = useCallback(() => photosApi.feed(null, { scope: effectiveScope }), [effectiveScope]);
  const feed = useAsync(load);
  const [more, setMore] = useState<{ items: Photo[]; cursor: string | null | undefined }>({ items: [], cursor: undefined });
  const [loadingMore, setLoadingMore] = useState(false);
  const [abNote, setAbNote] = useState<string | null>(null);
  const { entries } = useTraces();
  const last = latestTrace(entries, 'GET', '/api/feed');
  const cacheSeg = last?.path.modules.find((m) => m.module === 'cache');
  const cdnSeg = last?.path.modules.find((m) => m.module === 'cdn');
  const dbCount = timingCount(last, 'database');
  const cacheMs = last?.serverTiming.find((m) => m.name === 'cache')?.dur;
  const totalMs = last?.serverTiming.find((m) => m.name === 'total')?.dur;

  if (feed.errorObj instanceof ApiError && feed.errorObj.status === 401 && !signedIn) {
    return <Welcome />;
  }

  const items = [...(feed.data?.items ?? []), ...more.items];
  const cursor = more.cursor === undefined ? feed.data?.nextCursor : more.cursor;

  const loadMore = async () => {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const page = await photosApi.feed(cursor, { scope: effectiveScope });
      setMore((cur) => ({ items: [...cur.items, ...page.items], cursor: page.nextCursor ?? null }));
    } finally {
      setLoadingMore(false);
    }
  };

  const canBypass = auth.isAdmin && caps.lab.bypassEnabled && caps.lab.bypassKeys.includes('cache');
  const runAb = async () => {
    setAbNote(null);
    try {
      await photosApi.feed(null, { scope: effectiveScope, traceLabel: 'A' });
      await photosApi.feed(null, { scope: effectiveScope, bypass: ['cache'], traceLabel: 'B（旁路 cache）' });
      setAbNote('已发送 A（正常）与 B（X-Compare-Bypass: cache）两个请求：在“路径追踪”中勾选这两行即可并排对比。');
    } catch (e) {
      setAbNote(describeError(e));
    }
  };

  return (
    <>
      <div className="page-head">
        <div className="stack" style={{ gap: 4 }}>
          <h1>时间线</h1>
          <div className="row">
            <ModuleBadge module="cache" outcome={cacheSeg?.outcome} />
            <ModuleBadge module="database" outcome={last?.path.modules.find((m) => m.module === 'database')?.outcome} />
          </div>
        </div>
        <div className="row">
          {canBypass && <button type="button" className="btn btn-sm" onClick={() => void runAb()}>A/B：旁路缓存再请求一次</button>}
          {auth.user && !auth.user.restricted && <Link className="btn btn-primary" to="/upload">上传照片</Link>}
        </div>
      </div>
      {!signedIn && <Welcome compact />}
      {signedIn && (
        <nav className="tabs" aria-label="时间线范围">
          {(['mine', 'public'] as const).map((s) => (
            <a
              key={s}
              href={`?scope=${s}`}
              className={scope === s ? 'active' : ''}
              aria-current={scope === s ? 'page' : undefined}
              onClick={(e) => { e.preventDefault(); setMore({ items: [], cursor: undefined }); setScope(s); }}
            >
              {s === 'mine' ? '我的照片' : '公开照片'}
            </a>
          ))}
        </nav>
      )}
      {abNote && <p className="notice">{abNote}</p>}
      {feed.loading && !feed.data && <div className="grid-photos">{Array.from({ length: 8 }, (_, i) => <div key={i} className="skeleton" style={{ aspectRatio: '1 / 1' }} />)}</div>}
      {feed.error && <p className="notice notice-error" role="alert">{feed.error}</p>}
      {feed.data && items.length === 0 && (
        <div className="card">
          <p>时间线还是空的。</p>
          {auth.user ? <Link to="/upload">上传第一张照片</Link> : <Link to="/login">登录后上传照片</Link>}
        </div>
      )}
      {items.length > 0 && <PhotoGrid photos={items} cdnOutcome={cdnSeg?.outcome === 'bypass' ? 'bypass' : undefined} showOwner />}
      {cursor && (
        <div className="row" style={{ justifyContent: 'center', marginTop: 16 }}>
          <button type="button" className="btn" disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore ? '加载中…' : '加载更多'}</button>
        </div>
      )}
      {last && (
        <p className="subtle num" style={{ textAlign: 'right', marginTop: 12 }} title="来自最近一次 GET /api/feed 的 Server-Timing">
          {cacheSeg ? `cache=${cacheSeg.raw}` : 'cache 未调用'} · DB {dbCount} 次
          {cacheMs !== undefined ? ` · 缓存 ${cacheMs.toFixed(1)} ms` : ''}
          {totalMs !== undefined ? ` · 服务端 ${totalMs.toFixed(1)} ms` : ''}
        </p>
      )}
    </>
  );
}

function Welcome({ compact = false }: { compact?: boolean }) {
  if (compact) {
    return (
      <div className="notice row spread">
        <span>面向 AWS SAA-C03 学习者的云相册。<ModuleBadge module="auth" plain /></span>
        <span className="row"><Link className="btn btn-sm btn-primary" to="/login">登录</Link><Link className="btn btn-sm" to="/register">注册</Link></span>
      </div>
    );
  }
  return (
    <div className="card panel-narrow">
      <h1>CloudAlbum</h1>
      <p>面向 AWS SAA-C03 学习者的云相册：只有一台 EC2 时就能完整运行，每启用一个模块，对应的机能就从本地实现切换为 AWS 实现。</p>
      <div className="row">
        <Link className="btn btn-primary" to="/login">登录</Link>
        <Link className="btn" to="/register">注册</Link>
      </div>
      <p className="subtle" style={{ marginTop: 12 }}>登录方式：<ModuleBadge module="auth" plain /></p>
    </div>
  );
}
