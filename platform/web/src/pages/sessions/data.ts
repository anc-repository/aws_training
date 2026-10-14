/**
 * 会话、回收、报告、证书画面共用的数据 hooks（08 §2.6“状态”、§7）：
 * - `useSessionView`：先直接读一次会话视图（区分 404“没有这个会话”），再交给 SessionSync 订阅；终态且复扫结束的会话不再订阅
 *   （§7.3“终态（复扫结束）：停止”）；组件不自行轮询会话接口；
 * - `useApiData`：单个路由的读取，带可选的轮询（页面隐藏时暂停）与手动刷新；
 * - `useStaticJson`：同源静态内容（`/content/<v>/…`，不经 API），按 URL 缓存；
 * - `useLabContent` / `useCatalogCards`：手册 JSON 与目录索引（卡片标题、实验声明、步骤与检查标题）。
 */
import { isTerminal, type RouteId } from '@atl/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CallOptions } from '../../api/client';
import { isApiError, type ApiError } from '../../api/errors';
import type { SessionView } from '../../api/types';
import { useServices, useSessionSync } from '../../app/context';
import { useGlobalStatus } from '../../app/globalStatus';
import { contentUrl, fetchContentJson } from '../../i18n/content';
import { useLocale, useReloadOnLocale } from '../../i18n/hooks';

export type LoadStatus = 'loading' | 'ok' | 'missing' | 'error';

/** 会话视图中结果类画面还会用到的字段（platform/api services/sessions/view.ts；api/types.ts 只声明了框架用到的部分）。 */
export type SessionViewX = SessionView & {
  labVersion?: string | null;
  reuseOfEnvId?: string | null;
  startProfile?: string | null;
  disposition?: string | null;
  workstation?: { mode?: string; instanceId?: string | null } | null;
  cost?: {
    quoteId?: string;
    currency?: string;
    priceAsOf?: string | null;
    hourly?: { start?: { low?: number; high?: number } | null; completed?: { low?: number; high?: number } | null } | null;
    dimensions?: { service?: string | null; dimension?: string | null; detail?: string | null }[];
    incomplete?: string[];
    disclaimer?: string;
  } | null;
};

export function viewX(v: SessionView): SessionViewX {
  return v as SessionViewX;
}

/** 视图是否还需要订阅：非终态、复扫窗口内、释放未完成。 */
export function needsWatch(v: Pick<SessionView, 'state' | 'reclaim'> | null | undefined): boolean {
  if (!v) return false;
  if (!isTerminal(v.state)) return true;
  const followUp = (v.reclaim as { followUp?: string } | null | undefined)?.followUp;
  return followUp === 'PENDING';
}

export interface SessionViewHandle {
  view: SessionView | null;
  status: LoadStatus;
  error: ApiError | null;
  retry: () => void;
}

export function useSessionView(sid: string | undefined, opts: { watch?: (v: SessionView) => boolean } = {}): SessionViewHandle {
  const { api, sync } = useServices();
  const snap = useSessionSync();
  const [status, setStatus] = useState<LoadStatus>('loading');
  const [error, setError] = useState<ApiError | null>(null);
  const [attempt, setAttempt] = useState(0);
  const watchFn = useRef(opts.watch ?? needsWatch);
  watchFn.current = opts.watch ?? needsWatch;

  useEffect(() => {
    if (!sid) {
      setStatus('missing');
      return undefined;
    }
    let cancelled = false;
    setStatus('loading');
    setError(null);
    api
      .call<SessionView>('getSession', { params: { sid } })
      .then((r) => {
        if (cancelled) return;
        if (r.data) sync.applyView(r.data);
        setStatus(r.data ? 'ok' : 'missing');
      })
      .catch((e: unknown) => {
        if (cancelled || !isApiError(e)) return;
        setError(e);
        setStatus(e.status === 404 || e.code === 'NOT_FOUND' ? 'missing' : 'error');
      });
    return () => {
      cancelled = true;
    };
  }, [api, sync, sid, attempt]);

  const view = sid ? (snap.views[sid] ?? null) : null;
  const shouldWatch = status === 'ok' && !!view && watchFn.current(view);
  useEffect(() => (sid && shouldWatch ? sync.watch(sid) : undefined), [sync, sid, shouldWatch]);

  return { view: status === 'ok' ? view : null, status, error, retry: () => setAttempt((x) => x + 1) };
}

export interface ApiDataHandle<T> {
  data: T | null;
  error: ApiError | null;
  status: LoadStatus;
  /** 至少成功过一次。 */
  loaded: boolean;
  refresh: () => Promise<void>;
  setData: (d: T | null) => void;
}

/**
 * 读取一个路由。`key` 为 null 时不读取；`pollMs` 给定时在页面可见期间按间隔刷新（失败时保留上次的数据）。
 */
export function useApiData<T>(key: string | null, routeId: RouteId, call: CallOptions = {}, pollMs: number | null = null): ApiDataHandle<T> {
  const { api } = useServices();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [status, setStatus] = useState<LoadStatus>('loading');
  const [loaded, setLoaded] = useState(false);
  const callRef = useRef(call);
  callRef.current = call;
  const seq = useRef(0);

  const refresh = useCallback(async () => {
    if (key === null) return;
    const my = ++seq.current;
    try {
      const r = await api.call<T>(routeId, callRef.current);
      if (my !== seq.current) return;
      setData(r.data);
      setError(null);
      setStatus('ok');
      setLoaded(true);
    } catch (e) {
      if (!isApiError(e) || my !== seq.current) return;
      setError(e);
      setStatus(e.status === 404 || e.code === 'NOT_FOUND' ? 'missing' : 'error');
    }
  }, [api, key, routeId]);

  useEffect(() => {
    setData(null);
    setLoaded(false);
    setStatus(key === null ? 'ok' : 'loading');
    setError(null);
    if (key === null) return undefined;
    void refresh();
    if (!pollMs) return undefined;
    const id = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      void refresh();
    }, pollMs);
    return () => clearInterval(id);
  }, [key, pollMs, refresh]);
  // 界面语言变化：就地重取（Accept-Language 跟随新语言），保留旧数据直到新数据到达（09 §1.2）
  useReloadOnLocale(key === null ? null : refresh);

  return { data, error, status, loaded, refresh, setData };
}

// ---------------------------------------------------------------------------------------------------------------
// 静态内容（/content/<catalogVersion>/…，同源，不经 API）

const jsonCache = new Map<string, Promise<unknown>>();

/** 测试用。 */
export function clearStaticCache(): void {
  jsonCache.clear();
}

export function fetchStaticJson<T>(url: string): Promise<T | null> {
  // 按当前界面语言读取（09 §2.4）；缓存键是改写后的地址
  const key = contentUrl(url);
  let p = jsonCache.get(key);
  if (!p) {
    p = fetchContentJson<unknown>(url)
      .then((r) => (r.ok ? r.data : null))
      .catch(() => null);
    jsonCache.set(key, p);
    // 失败的请求不缓存，下次重新取
    void p.then((v) => {
      if (v === null) jsonCache.delete(key);
    });
  }
  return p as Promise<T | null>;
}

export function useStaticJson<T>(url: string | null): { data: T | null; loaded: boolean } {
  const [state, setState] = useState<{ url: string | null; data: T | null; loaded: boolean }>({ url: null, data: null, loaded: false });
  // 语言变化时按新语言重取（fetchStaticJson 读当前语言的地址）；同一 url 在新数据到达前保留旧数据
  const locale = useLocale();
  useEffect(() => {
    if (!url) return undefined;
    let cancelled = false;
    void fetchStaticJson<T>(url).then((data) => {
      if (!cancelled) setState({ url, data, loaded: true });
    });
    return () => {
      cancelled = true;
    };
  }, [url, locale]);
  return state.url === url ? { data: state.data, loaded: state.loaded } : { data: null, loaded: !url };
}

export interface LabStep {
  id: string;
  type?: string;
  title?: string;
  optional?: boolean;
  /** 发布格式里既有检查 ID 字符串，也有 `{ ref, required?, as? }`（as：结果里使用的别名）。 */
  checks?: (string | { ref: string; required?: boolean; as?: string })[];
}

/** 步骤里引用的检查：`id` 用于查声明（lab.checks），`key` 用于查结果（别名优先）。 */
export function stepCheckRefs(step: LabStep): { id: string; key: string; required: boolean }[] {
  const out: { id: string; key: string; required: boolean }[] = [];
  const seen = new Set<string>();
  for (const c of step.checks ?? []) {
    const id = typeof c === 'string' ? c : typeof c?.ref === 'string' ? c.ref : null;
    if (!id) continue;
    const key = typeof c === 'object' && typeof c.as === 'string' && c.as ? c.as : id;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ id, key, required: typeof c === 'object' ? c.required !== false : true });
  }
  return out;
}

export interface LabExperimentDecl {
  module: string;
  id: string;
  labels: (string | { id: string; role?: string; requires?: Record<string, string>; description?: string; title?: string })[];
  pairs?: [string, string][];
  required?: boolean;
  runner?: string;
  validity?: string;
  corroborateWith?: string[];
  compareAcross?: string[];
  title?: string;
  command?: string;
}

export interface LabContent {
  id: string;
  title?: string;
  kind?: string;
  version?: string;
  steps?: LabStep[];
  checks?: Record<string, { id?: string; title?: string; type?: string }>;
  experiments?: LabExperimentDecl[];
  workstation?: { required?: boolean; savingsMode?: string };
  /** 目标模块（wireStep：接入该模块的步骤；报告的构成图据此区分已完成与未完成的部分）。 */
  targetModules?: { id: string; wireStep?: string; optional?: boolean }[];
  catalogVersion?: string;
}

export function labContentUrl(catalogVersion: string | null | undefined, labId: string | null | undefined): string | null {
  if (!catalogVersion || !labId) return null;
  return `/content/${encodeURIComponent(catalogVersion)}/labs/${encodeURIComponent(labId)}.json`;
}

/** 手册 JSON：先取会话自己的内容版本，没有时退回当前目录版本。 */
export function useLabContent(catalogVersion: string | null | undefined, labId: string | null | undefined): { lab: LabContent | null; loaded: boolean } {
  const { catalog } = useGlobalStatus();
  const own = useStaticJson<LabContent>(labContentUrl(catalogVersion, labId));
  const fallbackUrl = own.loaded && !own.data && catalog?.catalogVersion && catalog.catalogVersion !== catalogVersion ? labContentUrl(catalog.catalogVersion, labId) : null;
  const fb = useStaticJson<LabContent>(fallbackUrl);
  if (own.data) return { lab: own.data, loaded: true };
  if (!fallbackUrl) return { lab: null, loaded: own.loaded };
  return { lab: fb.data, loaded: fb.loaded };
}

export interface CatalogCard {
  id: string;
  title?: string;
  kind?: 'service' | 'scenario';
  badge?: { title?: string; shape?: string } | string;
  category?: string;
  cat?: string;
  status?: string;
  /** 涉及的服务（taxonomy 服务 id；主服务 role=primary）：结果画面的服务图标（I6 f）。 */
  services?: { id: string; role?: string }[];
  /** 目标模块与起始变体：报告的构成图（ui/diagram archInputFromCatalogCard）。 */
  targets?: { module: string; from?: string | null; to?: string | null; optional?: boolean }[];
  startProfiles?: { variant?: string; select?: string; modules?: (string | { id?: string; module?: string })[] }[];
}

/** 卡片的主服务（目录索引 `services[].role=primary`，没有时取第一个目标模块）：ServiceGlyph 的 id。 */
export function primaryServiceOf(card: CatalogCard | null | undefined): string | null {
  if (!card) return null;
  return card.services?.find((s) => s.role === 'primary')?.id ?? card.services?.[0]?.id ?? card.targets?.[0]?.module ?? null;
}

export interface CatalogIndexJson {
  catalogVersion?: string;
  taxonomy?: { categories?: { id: string; label?: string }[] };
  cards?: CatalogCard[];
  tracks?: { id: string; title?: string; certificate?: { title?: string; enabled?: boolean } }[];
}

/** 目录索引（卡片标题、徽章名、路径证书名）。 */
export function useCatalogIndex(): CatalogIndexJson | null {
  const { catalog } = useGlobalStatus();
  const url = catalog?.indexUrl ?? (catalog?.catalogVersion ? `/content/${catalog.catalogVersion}/catalog/index.json` : null);
  return useStaticJson<CatalogIndexJson>(url).data;
}

export function cardTitle(index: CatalogIndexJson | null, labId: string): string | null {
  return index?.cards?.find((c) => c.id === labId)?.title ?? null;
}
