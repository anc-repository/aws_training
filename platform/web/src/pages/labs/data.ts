/**
 * 目录相关的数据读取（08 P02“数据来源”、P03、P10；05 §8.8）：
 * - 静态内容 `/content/<catalogVersion>/catalog/index.json`、`…/cards/<labId>.json` 不经 API，按地址缓存（路径带版本号，可长缓存）；
 * - API 资源用 useResource（只在页面可见时轮询；失败保留上次的数据，区块级错误不影响其他区块，08 §4.0）；
 * - 持有环境：SessionSync 的当前会话优先（与顶栏胶囊同源），其次 `GET /labs` 的 environment（05 §8.8）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, isApiError } from '../../api/errors';
import { useServices, useSessionSync } from '../../app/context';
import { isTerminal } from '@atl/shared';
import { serviceCells, type Holder, type ProgressLike, type ServiceCellView } from './model';
import type { CardIntro, CatalogCard, CatalogIndex, CatalogRef, LabsView, TrackDef } from './types';

// ---------------------------------------------------------------------------------------------------------------
// 静态内容

const contentCache = new Map<string, Promise<unknown>>();

/** 读取静态内容 JSON（同源，按地址缓存；失败的请求不缓存，便于重试）。 */
export function loadContent<T>(url: string): Promise<T> {
  const hit = contentCache.get(url);
  if (hit) return hit as Promise<T>;
  const p = (async () => {
    let r: Response;
    try {
      r = await globalThis.fetch(url, { credentials: 'same-origin' });
    } catch (e) {
      throw new ApiError({ status: 0, code: 'NETWORK', title: 'network error', detail: e instanceof Error ? e.message : String(e) });
    }
    if (!r.ok) throw new ApiError({ status: r.status, code: r.status === 404 ? 'NOT_FOUND' : r.status >= 500 ? 'UPSTREAM_UNAVAILABLE' : 'BAD_RESPONSE', title: `HTTP ${r.status}` });
    try {
      return (await r.json()) as T;
    } catch {
      throw new ApiError({ status: r.status, code: 'BAD_RESPONSE', title: 'content is not JSON' });
    }
  })();
  contentCache.set(url, p);
  p.catch(() => contentCache.delete(url));
  return p;
}

/** 测试用。 */
export function resetContentCache(): void {
  contentCache.clear();
}

// ---------------------------------------------------------------------------------------------------------------
// 通用资源 hook

export interface Resource<T> {
  data: T | null;
  error: ApiError | null;
  loading: boolean;
  /** 至少完成过一次（成功或失败）。 */
  settled: boolean;
  reload: () => void;
}

export interface ResourceOptions {
  /** 页面可见时的轮询间隔；null 不轮询。 */
  pollMs?: number | null;
  /** 页面重新可见时刷新（P09、P10“进入与重新可见时刷新”）。 */
  refreshOnVisible?: boolean;
}

function toApiError(e: unknown): ApiError {
  if (isApiError(e)) return e;
  return new ApiError({ status: 0, code: 'BAD_RESPONSE', title: e instanceof Error ? e.message : String(e) });
}

/** `key` 为 null 时不加载；`key` 变化时重新加载（保留旧数据直到新数据到达，避免布局跳动，08 §7.6 第 5 条）。 */
export function useResource<T>(key: string | null, load: () => Promise<T | null>, opts: ResourceOptions = {}): Resource<T> {
  const [state, setState] = useState<{ key: string | null; data: T | null; error: ApiError | null; loading: boolean; settled: boolean }>({
    key,
    data: null,
    error: null,
    loading: key !== null,
    settled: false,
  });
  const loadRef = useRef(load);
  loadRef.current = load;
  const seq = useRef(0);
  const run = useCallback(() => {
    if (key === null) return;
    const my = ++seq.current;
    setState((s) => ({ ...s, key, loading: true, ...(s.key !== key ? { data: null, error: null, settled: false } : {}) }));
    loadRef
      .current()
      .then((data) => {
        if (my === seq.current) setState({ key, data, error: null, loading: false, settled: true });
      })
      .catch((e: unknown) => {
        if (my === seq.current) setState((s) => ({ key, data: s.key === key ? s.data : null, error: toApiError(e), loading: false, settled: true }));
      });
  }, [key]);

  useEffect(() => {
    run();
    // 卸载或 key 变化后，进行中的请求结果作废（序号前移）
    const counter = seq;
    return () => {
      counter.current++;
    };
  }, [run]);

  const { pollMs = null, refreshOnVisible = false } = opts;
  useEffect(() => {
    if (key === null || (!pollMs && !refreshOnVisible)) return undefined;
    const id = pollMs
      ? setInterval(() => {
          if (typeof document !== 'undefined' && document.hidden) return;
          run();
        }, pollMs)
      : null;
    const onVis = () => {
      if (!document.hidden) run();
    };
    if (refreshOnVisible || pollMs) document.addEventListener('visibilitychange', onVis);
    return () => {
      if (id) clearInterval(id);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [key, pollMs, refreshOnVisible, run]);

  return { data: state.key === key ? state.data : null, error: state.key === key ? state.error : null, loading: state.loading, settled: state.key === key && state.settled, reload: run };
}

// ---------------------------------------------------------------------------------------------------------------
// 目录

export interface CatalogData {
  ref: CatalogRef | null;
  index: CatalogIndex | null;
  error: ApiError | null;
  loading: boolean;
  reload: () => void;
  cards: ReadonlyMap<string, CatalogCard>;
  tracks: ReadonlyMap<string, TrackDef>;
  cells: readonly ServiceCellView[];
}

/** `GET /catalog` → 静态索引 index.json。 */
export function useCatalog(): CatalogData {
  const { api } = useServices();
  const ref = useResource<CatalogRef>('catalog', () => api.get<CatalogRef>('getCatalog'));
  const indexUrl = ref.data?.indexUrl ?? (ref.data ? `/content/${ref.data.catalogVersion}/catalog/index.json` : null);
  const idx = useResource<CatalogIndex>(indexUrl, () => loadContent<CatalogIndex>(indexUrl!));
  const index = idx.data;
  const cards = useMemo(() => new Map((index?.cards ?? []).map((c) => [c.id, c])), [index]);
  const tracks = useMemo(() => new Map((index?.tracks ?? []).map((x) => [x.id, x])), [index]);
  const cells = useMemo(() => (index ? serviceCells(index) : []), [index]);
  const reloadRef = ref.reload;
  const reloadIdx = idx.reload;
  const reload = useCallback(() => {
    reloadRef();
    reloadIdx();
  }, [reloadRef, reloadIdx]);
  return {
    ref: ref.data,
    index,
    error: ref.error ?? idx.error,
    loading: ref.loading || idx.loading || (!!indexUrl && !idx.settled),
    reload,
    cards,
    tracks,
    cells,
  };
}

/** 简介页静态数据（CardIntro）。 */
export function useCardIntro(ref: CatalogRef | null, labId: string): Resource<CardIntro> {
  const url = ref
    ? (ref.cardIntroUrlTemplate ?? `/content/${ref.catalogVersion}/catalog/cards/{labId}.json`).replace('{labId}', encodeURIComponent(labId))
    : null;
  return useResource<CardIntro>(url, () => loadContent<CardIntro>(url!));
}

export const LABS_POLL_MS = 60_000;
export const LABS_FAST_POLL_MS = 10_000;

/** `GET /labs`：页面可见时 60 秒；环境处于准备或结束阶段时 10 秒（05 §8.8）。 */
export function useLabs(enabled = true): Resource<LabsView> {
  const { api } = useServices();
  const [fast, setFast] = useState(false);
  const res = useResource<LabsView>(enabled ? 'labs' : null, () => api.get<LabsView>('listLabs'), { pollMs: fast ? LABS_FAST_POLL_MS : LABS_POLL_MS });
  const st = res.data?.environment?.state;
  const wantFast = st === 'REQUESTED' || st === 'PROVISIONING' || st === 'ENDING' || st === 'CLEANING';
  useEffect(() => setFast(wantFast), [wantFast]);
  return res;
}

/** 卡片 id → 个人进度（GET /labs 的 items；没有记录的卡片视为未开始）。 */
export function progressMap(labs: LabsView | null | undefined): Map<string, ProgressLike & { attempts?: number; lastSession?: LabsView['items'][number]['lastSession'] }> {
  return new Map((labs?.items ?? []).map((i) => [i.labId, { status: i.status, badge: i.badge ?? null, attempts: i.attempts, lastSession: i.lastSession ?? null }]));
}

/** 持有环境的会话：SessionSync 的当前会话（非终态）优先，其次 GET /labs 的 environment。 */
export function useHolder(labs: LabsView | null | undefined): Holder | null {
  const { current } = useSessionSync();
  return useMemo(() => {
    if (current && !isTerminal(current.state)) {
      return {
        labId: current.labId,
        sessionId: current.sessionId,
        state: current.state,
        deadlineAt: current.deadlineAt ?? null,
        keepUntil: current.keep?.until ?? current.env?.keepUntil ?? null,
      };
    }
    const e = labs?.environment;
    if (e && !isTerminal(e.state)) return { labId: e.holderLabId, sessionId: e.sessionId, state: e.state, deadlineAt: e.deadlineAt ?? null, keepUntil: e.keepUntil ?? null };
    return null;
  }, [current, labs]);
}

/** 修改当前路径（PATCH /me {currentTrackId}）。 */
export function useSetCurrentTrack(): (trackId: string) => Promise<void> {
  const { api } = useServices();
  return useCallback(
    async (trackId: string) => {
      await api.call('patchMe', { body: { currentTrackId: trackId } });
    },
    [api],
  );
}
