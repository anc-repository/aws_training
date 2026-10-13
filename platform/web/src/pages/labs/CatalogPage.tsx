/**
 * P02 卡片目录 `/labs`（08 §4 P02；05 §2）：三种视图（卡片网格 / 服务地图 / 路径）、筛选、搜索、排序、分组，
 * 页头的当前环境条 EnvironmentBar 与继续学习条 ContinueStrip。
 *
 * - 视图、分组、筛选、排序、搜索全部写入查询串（可分享、可后退）；URL 没有参数时恢复 localStorage 中上次的组合（`atl.catalog.v1`）；
 * - 计数与结果在浏览器计算，结果变化时读屏播报“显示 5 / 56 张卡片”；`/` 聚焦搜索、`Esc` 清空；
 * - 先渲染静态索引 index.json，个人状态（GET /labs，60 秒，环境准备或结束中 10 秒）到达后填充；
 *   个人进度失败时卡片照常显示、状态区“状态暂不可用”、“状态”筛选维度置灰；掌握度失败时地图照常显示格子；
 * - planned 卡片照常显示（“即将推出”），只能看简介，不能开始（简介页处理）。
 * 目录页不订阅会话事件：环境条的倒计时由 SessionSync 驱动，卡片状态随 GET /labs 轮询更新（05 §8.8）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { SessionView } from '../../api/types';
import { useAuth, useServices, useSessionSync } from '../../app/context';
import { useGlobalStatus } from '../../app/globalStatus';
import { shortcutsEnabled } from '../../components/globalHooks';
import { t, zhCN } from '../../i18n/zh-CN';
import { announce } from '../../lib/announce';
import { lsGet, lsSet, ssGet, ssSet } from '../../lib/storage';
import { EmptyState, ErrorPanel, Icon, Skeleton } from '../../ui';
import './catalog.css';
import { CardRowCompact, CardTile } from './components/CardTile';
import { EnvironmentBar } from './components/EnvironmentBar';
import { ContinueStrip, FacetBar, filterSummary } from './components/FacetBar';
import { ServiceCellPanel, ServiceMap } from './components/ServiceMap';
import { TrackHead, TrackStageList } from './components/TrackView';
import { CATALOG_PREFS_KEY, SETUP_SKIPPED_KEY } from './keys';
import { progressMap, useCatalog, useHolder, useLabs, useResource, useSetCurrentTrack } from './data';
import {
  activeFilterCount,
  cardFlags,
  cardStateOf,
  emptyQuery,
  facetCounts,
  filterCards,
  groupCards,
  hasCatalogParams,
  parseCatalogQuery,
  pathOrderOf,
  recommendNext,
  serializeCatalogQuery,
  sortCards,
  trackSummary,
  type CatalogQuery,
  type FilterContext,
} from './model';
import { DOMAIN_TEXT, S } from './strings';
import type { CatalogIndex, LabItem, MasteryView, SessionListItem, ServiceMasteryView } from './types';


/** A、O 没有当前会话时由 GET /labs 的 environment 拼出环境条需要的最小视图。 */
function viewFromStrip(e: NonNullable<ReturnType<typeof useLabs>['data']>['environment']): SessionView | null {
  if (!e) return null;
  return {
    sessionId: e.sessionId,
    labId: e.holderLabId,
    state: e.state,
    ver: 0,
    createdAt: '',
    deadlineAt: e.deadlineAt ?? null,
    keep: e.keepUntil ? { until: e.keepUntil } : null,
    env: e.envId ? { envId: e.envId, keepUntil: e.keepUntil ?? null } : null,
  };
}

function useCatalogQuery(index: CatalogIndex | null) {
  const [sp, setSp] = useSearchParams();
  const defaults = useMemo(
    () => ({
      view: (index?.defaults?.view as CatalogQuery['view']) ?? 'grid',
      group: (index?.defaults?.group as CatalogQuery['group']) ?? 'kind',
      sort: (index?.defaults?.sort as CatalogQuery['sort']) ?? 'path',
    }),
    [index],
  );
  const restored = useRef(false);
  const restoring = useRef(false);
  // URL 没有目录参数时恢复上次的视图与筛选（URL 有参数时以 URL 为准，05 §2.7 规则 4）
  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    if (hasCatalogParams(sp)) return;
    const saved = lsGet<string | null>(CATALOG_PREFS_KEY, null);
    if (saved && typeof saved === 'string') {
      const q = parseCatalogQuery(new URLSearchParams(saved), defaults);
      const next = serializeCatalogQuery({ ...q, cell: null }, defaults);
      if ([...next.keys()].length) {
        restoring.current = true;
        setSp(next, { replace: true });
      }
    }
  }, [sp, setSp, defaults]);
  const query = useMemo(() => parseCatalogQuery(sp, defaults), [sp, defaults]);
  // 当前组合（视图链接、筛选、排序……任何方式改变的）都记下来，下次 URL 没有参数时恢复
  const saved = serializeCatalogQuery({ ...query, cell: null }, defaults).toString();
  useEffect(() => {
    if (restoring.current) {
      if (!saved) return;
      restoring.current = false;
    }
    lsSet(CATALOG_PREFS_KEY, saved);
  }, [saved]);
  const setQuery = useCallback(
    (q: CatalogQuery, opts: { replace?: boolean } = {}) => {
      setSp(serializeCatalogQuery(q, defaults), { replace: opts.replace ?? false });
    },
    [setSp, defaults],
  );
  return { query, setQuery };
}

export default function CatalogPage() {
  const { api } = useServices();
  const auth = useAuth();
  const role = auth.principal?.role ?? null;
  const status = useGlobalStatus();
  const { current } = useSessionSync();
  const catalog = useCatalog();
  const { index, cards, cells } = catalog;
  const labs = useLabs();
  const { query, setQuery } = useCatalogQuery(index);
  const holder = useHolder(labs.data);
  const setCurrentTrack = useSetCurrentTrack();
  const [trackBusy, setTrackBusy] = useState(false);
  const [facetsOpen, setFacetsOpen] = useState(false);
  const [search, setSearch] = useState(query.q);
  const searchRef = useRef<HTMLInputElement>(null);
  const [skipped, setSkipped] = useState(() => ssGet<boolean>(SETUP_SKIPPED_KEY, false));

  // 掌握度：服务地图视图需要（与 GET /labs 同步刷新）
  const mastery = useResource<MasteryView>(query.view === 'map' ? 'mastery' : null, () => api.get<MasteryView>('getMyMastery'), { pollMs: 60_000 });
  // 最近尝试：GET /labs 不含时间，排序时取会话列表的开始时间
  const sessions = useResource<{ items: SessionListItem[] }>(query.sort === 'recent' ? 'sessions-recent' : null, () =>
    api.get<{ items: SessionListItem[] }>('listSessions', { query: { limit: 100 } }),
  );

  useEffect(() => setSearch(query.q), [query.q]);

  // 搜索：输入 180ms 后写入查询串（replace，不刷屏历史）
  useEffect(() => {
    if (search === query.q) return undefined;
    const id = setTimeout(() => setQuery({ ...query, q: search }, { replace: true }), 180);
    return () => clearTimeout(id);
  }, [search, query, setQuery]);

  // `/` 聚焦搜索（输入框外；单键快捷键可在设置中关闭）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey || !shortcutsEnabled()) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName))) return;
      e.preventDefault();
      searchRef.current?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const items = useMemo(() => new Map<string, LabItem>((labs.data?.items ?? []).map((i) => [i.labId, i])), [labs.data]);
  const progress = useMemo(() => progressMap(labs.data), [labs.data]);
  const personal: 'ok' | 'loading' | 'failed' = labs.data ? 'ok' : labs.error ? 'failed' : 'loading';
  const currentTrackId = status.me?.currentTrackId ?? labs.data?.currentTrackId ?? index?.defaults?.track ?? 'saa-main';
  const track = index?.tracks.find((x) => x.id === currentTrackId) ?? index?.tracks[0] ?? null;
  const summary = useMemo(() => (track ? trackSummary(track, progress, holder?.labId) : null), [track, progress, holder]);
  const rec = useMemo(() => recommendNext(track, progress, holder, cards), [track, progress, holder, cards]);
  const nowMs = Date.now();

  const filterCtx: FilterContext = useMemo(
    () => ({
      tax: index?.taxonomy,
      statusOf: labs.data ? (id: string) => cardStateOf(id, holder, items.get(id), nowMs).group : null,
    }),
    // nowMs 只影响“进行中”的剩余时间文字，不影响归类
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [index, labs.data, holder, items],
  );
  const allCards = useMemo(() => index?.cards ?? [], [index]);
  const filtered = useMemo(() => filterCards(allCards, query, filterCtx), [allCards, query, filterCtx]);
  const counts = useMemo(() => facetCounts(allCards, query, filterCtx), [allCards, query, filterCtx]);
  const lastAt = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of sessions.data?.items ?? []) m.set(s.labId, Math.max(m.get(s.labId) ?? 0, Date.parse(s.createdAt) || 0));
    return m;
  }, [sessions.data]);
  const sorted = useMemo(() => {
    if (!index) return [];
    return sortCards(filtered, query.sort, { pathOrder: pathOrderOf(index, currentTrackId), lastAttemptAt: (id) => lastAt.get(id) ?? 0 });
  }, [index, filtered, query.sort, currentTrackId, lastAt]);
  const sections = useMemo(
    () => (index ? groupCards(sorted, query.group, { tax: index.taxonomy, onlyPrimary: query.primary, domainLabel: (d) => DOMAIN_TEXT[d] }) : []),
    [index, sorted, query.group, query.primary],
  );

  // 结果变化时播报“显示 5 / 56 张卡片”（3 秒内合并）
  const first = useRef(true);
  const shown = filtered.length;
  const total = allCards.length;
  useEffect(() => {
    if (!total) return;
    if (first.current) {
      first.current = false;
      return;
    }
    announce(t(S.catalog.shownAnnounce, { n: shown, total }), { topic: 'catalog-count' });
  }, [shown, total]);

  const masteryMap = useMemo(() => (mastery.data ? new Map<string, ServiceMasteryView>(mastery.data.services.map((m) => [m.id, m])) : null), [mastery.data]);
  const dimmed = useMemo(() => {
    if (query.view !== 'map') return undefined;
    const active = query.kind.length || query.dom.length || query.st.length;
    if (!active) return undefined;
    const ok = new Set(filterCards(allCards, { ...emptyQuery(), kind: query.kind, dom: query.dom, st: query.st, primary: query.primary }, filterCtx).map((c) => c.id));
    return new Set(cells.filter((c) => ![c.serviceCard, ...(c.creditedBy ?? [])].some((id) => id && ok.has(id))).map((c) => c.id));
  }, [query, allCards, filterCtx, cells]);

  const envView = current ?? viewFromStrip(labs.data?.environment ?? null);
  const newLearner = !!labs.data && !holder && (labs.data.items ?? []).every((i) => !i.attempts && i.status === 'not_started');
  const firstCardId = track?.stages[0]?.items.find((i) => i.card)?.card ?? null;

  const onSetTrack = async (trackId: string) => {
    setTrackBusy(true);
    try {
      await setCurrentTrack(trackId);
      await status.refreshMe();
      announce(t(S.track.setCurrentDone, { name: index?.tracks.find((x) => x.id === trackId)?.title ?? trackId }));
    } catch {
      /* 失败时保持原样；全局离线条与错误提示由客户端处理 */
    } finally {
      setTrackBusy(false);
    }
  };

  if (catalog.error && !index) {
    return (
      <div className="stack-16">
        <div className="ph">
          <h1 tabIndex={-1}>{S.catalog.title}</h1>
        </div>
        <ErrorPanel error={catalog.error} onRetry={catalog.reload} overrides={{ NOT_FOUND: S.catalog.notPublished }} />
      </div>
    );
  }
  if (!index) {
    return (
      <div className="stack-16">
        <div className="ph">
          <h1 tabIndex={-1}>{S.catalog.title}</h1>
        </div>
        <Skeleton lines={6} block onRetry={catalog.reload} />
      </div>
    );
  }

  const tax = index.taxonomy;
  const svcN = allCards.filter((c) => c.kind === 'service').length;
  const nFilters = activeFilterCount(query);
  const viewLink = (v: CatalogQuery['view']) => {
    const next = serializeCatalogQuery({ ...query, view: v, cell: null }, { view: (index.defaults?.view as CatalogQuery['view']) ?? 'grid', group: (index.defaults?.group as CatalogQuery['group']) ?? 'kind', sort: (index.defaults?.sort as CatalogQuery['sort']) ?? 'path' }).toString();
    return next ? `/labs?${next}` : '/labs';
  };
  const selectedCell = query.view === 'map' && query.cell ? (cells.find((c) => c.id === query.cell) ?? null) : null;
  const viewTrack = query.view === 'tracks' ? (index.tracks.find((x) => x.id === (query.track ?? currentTrackId)) ?? track) : null;
  const viewTrackSummary = viewTrack ? trackSummary(viewTrack, progress, holder?.labId) : null;
  const viewTrackRec = viewTrack ? recommendNext(viewTrack, progress, holder, cards) : null;

  return (
    <div className="stack-8" data-screen="P02">
      <div className="ph center">
        <h1 tabIndex={-1}>{S.catalog.title}</h1>
        <span className="sub">{t(S.catalog.sub, { n: allCards.length, svc: svcN, sc: allCards.length - svcN, v: index.catalogVersion })}</span>
        <span className="spacer" />
        <div className="search" role="search">
          <Icon name="search" />
          <input
            ref={searchRef}
            className="input"
            type="search"
            placeholder={S.catalog.searchPlaceholder}
            aria-label={S.catalog.searchLabel}
            autoComplete="off"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && search) {
                e.stopPropagation();
                setSearch('');
                setQuery({ ...query, q: '' }, { replace: true });
              }
            }}
          />
        </div>
      </div>
      {skipped ? (
        <div className="note blue setup-skipped" role="status">
          <span className="grow">{S.catalog.skippedSetup}</span>
          <button
            type="button"
            className="btn sm ghost icon"
            aria-label={zhCN.banners.dismiss}
            onClick={() => {
              ssSet(SETUP_SKIPPED_KEY, undefined);
              setSkipped(false);
            }}
          >
            <Icon name="x" />
          </button>
        </div>
      ) : null}
      <div className="stack-8">
        <EnvironmentBar view={envView} cards={cards} nextLabId={rec?.labId ?? null} />
        <ContinueStrip
          track={track}
          summary={summary}
          rec={rec}
          recCard={rec ? (cards.get(rec.labId) ?? null) : null}
          hasEnvironment={!!holder}
          newLearner={newLearner}
          firstCardId={firstCardId}
        />
      </div>
      <div className="toolbar">
        <nav className="seg" aria-label={S.catalog.viewLabel}>
          {(['grid', 'map', 'tracks'] as const).map((v) => (
            <Link key={v} to={viewLink(v)} aria-current={query.view === v ? 'page' : undefined}>
              {v === 'grid' ? S.catalog.viewGrid : v === 'map' ? S.catalog.viewMap : S.catalog.viewTracks}
            </Link>
          ))}
        </nav>
        {query.view === 'grid' ? (
          <>
            <label className="small muted" htmlFor="cat-group">
              {S.catalog.group}
            </label>
            <select id="cat-group" className="input auto" value={query.group} onChange={(e) => setQuery({ ...query, group: e.target.value as CatalogQuery['group'] })}>
              <option value="kind">{S.catalog.groupKind}</option>
              <option value="category">{S.catalog.groupCategory}</option>
              <option value="domain">{S.catalog.groupDomain}</option>
              <option value="none">{S.catalog.groupNone}</option>
            </select>
            <label className="small muted" htmlFor="cat-sort">
              {S.catalog.sort}
            </label>
            <select id="cat-sort" className="input auto" value={query.sort} onChange={(e) => setQuery({ ...query, sort: e.target.value as CatalogQuery['sort'] })}>
              <option value="path">{S.catalog.sortPath}</option>
              <option value="duration">{S.catalog.sortDuration}</option>
              <option value="cost">{S.catalog.sortCost}</option>
              <option value="recent">{S.catalog.sortRecent}</option>
            </select>
          </>
        ) : null}
        {query.view !== 'tracks' ? (
          <button type="button" className="btn sm only-sm" aria-expanded={facetsOpen} aria-controls="cat-facets" onClick={() => setFacetsOpen((v) => !v)}>
            {t(S.catalog.filters, { n: nFilters })}
          </button>
        ) : null}
      </div>
      {personal === 'failed' ? (
        <div className="note amber" role="status">
          <span className="grow">{S.catalog.statusUnavailable}</span>
          <button type="button" className="btn sm" onClick={labs.reload}>
            {S.catalog.retry}
          </button>
        </div>
      ) : null}

      {query.view === 'grid' ? (
        <>
          <FacetBar
            id="cat-facets"
            query={query}
            counts={counts}
            tax={tax}
            shown={shown}
            total={total}
            statusDisabled={!labs.data}
            collapsed={!facetsOpen}
            onChange={(q) => setQuery(q, { replace: true })}
          />
          {shown ? (
            sections.map((sec) => (
              <section key={sec.id} className="csec" aria-labelledby={`sec-${sec.id}`} data-section={sec.id}>
                <h2 id={`sec-${sec.id}`}>
                  {sec.title}{' '}
                  <span className="n">{t(S.catalog.sectionCount, { n: sec.cards.length, done: sec.cards.filter((c) => cardStateOf(c.id, null, items.get(c.id), nowMs).group === 'completed').length })}</span>
                </h2>
                {sec.cards.length ? (
                  <div className="cgrid">
                    {sec.cards.map((c) => (
                      <CardTile
                        key={c.id}
                        card={c}
                        tax={tax}
                        item={items.get(c.id)}
                        holder={holder}
                        personal={personal}
                        query={query.q}
                        flags={cardFlags(c, { drRegion: catalog.ref?.drRegion ?? null, completedMajor: items.get(c.id)?.completedMajorVersion ?? null })}
                      />
                    ))}
                  </div>
                ) : null}
                {sec.also.length ? (
                  <div>
                    <div className="small muted">{S.catalog.alsoDomain}</div>
                    {sec.also.map((c) => (
                      <CardRowCompact key={c.id} card={c} item={items.get(c.id)} holder={holder} />
                    ))}
                  </div>
                ) : null}
                {sec.id === 'dom-cost' && query.primary && sec.cards.length < 3 ? <p className="small muted">{S.catalog.costPrimaryOnlyHint}</p> : null}
              </section>
            ))
          ) : (
            <div className="cgrid-empty">
              <EmptyState
                title={S.catalog.emptyTitle}
                action={
                  <button
                    type="button"
                    className="btn"
                    onClick={() => {
                      setSearch('');
                      setQuery({ ...query, q: '', kind: [], svc: [], dom: [], d: [], dur: [], cost: [], st: [], nomanual: false, primary: false });
                      announce(t(S.catalog.cleared, { total }));
                    }}
                  >
                    {S.catalog.clear}
                  </button>
                }
              >
                {filterSummary(query, tax)}
                {query.nomanual && filterCards(allCards, { ...query, nomanual: false }, filterCtx).length ? ` ${S.catalog.emptyNoManual}` : ''}
              </EmptyState>
            </div>
          )}
          <section className="csec" aria-labelledby="sec-shelf">
            <h2 id="sec-shelf">{S.catalog.otherTracks}</h2>
            <div className="shelf">
              {index.tracks
                .filter((x) => x.id !== track?.id)
                .map((x) => {
                  const p = trackSummary(x, progress, holder?.labId);
                  return (
                    <Link key={x.id} to={`/tracks/${x.id}`}>
                      {x.title ?? x.id} <span className="tnum faint">{`${p.counted}/${p.min}`}</span> · <span className="small">{p.eligible ? S.catalog.certEligible : S.catalog.certNotYet}</span>
                    </Link>
                  );
                })}
            </div>
          </section>
        </>
      ) : null}

      {query.view === 'map' ? (
        <>
          <FacetBar
            id="cat-facets"
            query={query}
            counts={counts}
            tax={tax}
            shown={shown}
            total={total}
            statusDisabled={!labs.data}
            collapsed={!facetsOpen}
            only={['kind', 'dom', 'st']}
            compact
            onChange={(q) => setQuery(q, { replace: true })}
          />
          {mastery.error && !mastery.data ? (
            <div className="note amber" role="status">
              <span className="grow">{S.catalog.masteryUnavailable}</span>
              <button type="button" className="btn sm" onClick={mastery.reload}>
                {S.catalog.retry}
              </button>
            </div>
          ) : null}
          <ServiceMap
            cells={cells}
            tax={tax}
            mastery={masteryMap}
            progress={progress}
            selected={query.cell}
            dimmed={dimmed}
            onSelect={(id) => setQuery({ ...query, cell: id })}
          />
          <ServiceCellPanel
            cell={selectedCell}
            index={index}
            cards={cards}
            mastery={selectedCell ? (masteryMap?.get(selectedCell.id) ?? null) : null}
            items={items}
            holder={holder}
            onClose={() => setQuery({ ...query, cell: null }, { replace: true })}
          />
        </>
      ) : null}

      {query.view === 'tracks' && viewTrack && viewTrackSummary ? (
        <div className="stack" data-track-view={viewTrack.id}>
          <div className="row">
            <label className="small muted" htmlFor="cat-track">
              {S.track.pick}
            </label>
            <select id="cat-track" className="input auto" value={viewTrack.id} onChange={(e) => setQuery({ ...query, track: e.target.value })}>
              {index.tracks.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.title ?? x.id}（{x.id}）
                </option>
              ))}
            </select>
            <Link className="btn sm" to={`/tracks/${viewTrack.id}`}>
              {S.track.detail}
            </Link>
          </div>
          <TrackHead
            track={viewTrack}
            summary={viewTrackSummary}
            cert={viewTrackSummary.eligible ? 'eligible' : 'not-yet'}
            canSetCurrent={role === 'L'}
            isCurrent={viewTrack.id === currentTrackId}
            busy={trackBusy}
            onSetCurrent={() => void onSetTrack(viewTrack.id)}
          />
          <div className="small muted">
            {t(S.track.hours, {
              who: viewTrack.audience ?? '',
              req: Math.round((viewTrack.requiredMinutes ?? 0) / 60),
              all: Math.round((viewTrack.totalMinutes ?? 0) / 60),
            })}
          </div>
          <TrackStageList track={viewTrack} cards={cards} items={items} progress={progress} holder={holder} recommendedId={viewTrackRec?.labId ?? null} />
        </div>
      ) : null}
    </div>
  );
}
