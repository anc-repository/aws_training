/**
 * 全局框架的数据（08 §3、§7.3“没有会话的页面”、§7.5“全局框架”）：
 * - `GET /platform`：进入时读取；连续 3 次失败 → 守卫第 4 条“平台暂时不可用”（可重试）；
 * - `GET /me`：显示名、当前路径、首次设置完成（`onboarding.completedAt`；回写前用 localStorage `atl.onboarded.v1` 降级，§9.2 #4）；
 * - `GET /platform/guardrails`：5 分钟（预算横幅、卸载）；
 * - `GET /catalog`：60 秒（ETag；版本变化 → 横幅 8“目录已更新”）；
 * - `GET /resources/manual`：学员与助教 60 秒（横幅 2“释放未完成”；观察者无权读取，不调用，§1.5）；
 * - 目录索引 `/content/<catalogVersion>/catalog/index.json`（静态，不经 API）：只取各卡片的费用档位 `costTier.required`，
 *   供顶栏会话胶囊显示（§3.3）；目录画面自己读取完整索引。
 * 列表类轮询只在页面可见时进行。
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ApiError } from '../api/errors';
import { isApiError } from '../api/errors';
import type { CatalogView, GuardrailsView, ManualResourcesView, MeView, PlatformView } from '../api/types';
import type { CostTier } from '../ui/semantics';
import { lsGet, lsSet, STORAGE_KEYS } from '../lib/storage';
import { useAuth, useServices } from './context';

export interface GlobalStatus {
  platform: { status: 'loading' | 'ok' | 'failed'; data: PlatformView | null; error: ApiError | null };
  me: MeView | null;
  /** /me 已返回（成功或失败）；之前守卫不判断首次设置。 */
  meLoaded: boolean;
  guardrails: GuardrailsView | null;
  catalog: CatalogView | null;
  /** 进入页面后目录版本发生了变化（横幅 8）。 */
  catalogUpdatedTo: string | null;
  manual: ManualResourcesView | null;
  /** 卡片 id → 必需步骤的费用档位（目录索引）。 */
  costTiers: Readonly<Record<string, CostTier>>;
  onboardingDone: boolean;
  retryPlatform: () => void;
  /** 首次设置完成：写 PATCH /me（onboarding）并在本机记一份降级标记。 */
  markOnboarded: () => Promise<void>;
  refreshMe: () => Promise<void>;
}

const Ctx = createContext<GlobalStatus | null>(null);

export const GUARDRAILS_POLL_MS = 5 * 60_000;
export const CATALOG_POLL_MS = 60_000;
export const MANUAL_POLL_MS = 60_000;
export const PLATFORM_ATTEMPTS = 3;

/** 页面可见时按间隔调用 fn；enabled 变化时立即调用一次。 */
export function usePoll(fn: () => Promise<void> | void, intervalMs: number, enabled: boolean): void {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (!enabled) return undefined;
    void ref.current();
    const id = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      void ref.current();
    }, intervalMs);
    return () => clearInterval(id);
  }, [enabled, intervalMs]);
}

export function GlobalStatusProvider({ children }: { children: ReactNode }) {
  const { api } = useServices();
  const auth = useAuth();
  const authed = auth.status === 'authenticated' && !auth.expired;
  const role = auth.principal?.role ?? null;

  const [platform, setPlatform] = useState<GlobalStatus['platform']>({ status: 'loading', data: null, error: null });
  const [me, setMe] = useState<MeView | null>(null);
  const [meLoaded, setMeLoaded] = useState(false);
  const [guardrails, setGuardrails] = useState<GuardrailsView | null>(null);
  const [catalog, setCatalog] = useState<CatalogView | null>(null);
  const [firstCatalog, setFirstCatalog] = useState<string | null>(null);
  const [manual, setManual] = useState<ManualResourcesView | null>(null);
  const [costTiers, setCostTiers] = useState<Readonly<Record<string, CostTier>>>({});
  const [localOnboarded, setLocalOnboarded] = useState(() => lsGet<boolean>(STORAGE_KEYS.onboarded, false));
  const [platformTry, setPlatformTry] = useState(0);

  useEffect(() => {
    if (!authed) return undefined;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const attempt = async (n: number) => {
      try {
        const data = await api.get<PlatformView>('getPlatform');
        if (!cancelled) setPlatform({ status: 'ok', data, error: null });
      } catch (e) {
        if (cancelled || !isApiError(e)) return;
        if (n + 1 >= PLATFORM_ATTEMPTS) setPlatform({ status: 'failed', data: null, error: e });
        else timer = setTimeout(() => void attempt(n + 1), 1000 * 2 ** n);
      }
    };
    setPlatform((p) => (p.status === 'ok' ? p : { status: 'loading', data: null, error: null }));
    void attempt(0);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [api, authed, platformTry]);

  const refreshMe = useCallback(async () => {
    try {
      setMe(await api.get<MeView>('getMe'));
    } catch {
      /* 个人资料失败不阻塞框架；画面各自显示区块错误 */
    } finally {
      setMeLoaded(true);
    }
  }, [api]);
  useEffect(() => {
    if (authed) void refreshMe();
  }, [authed, refreshMe]);

  usePoll(
    async () => {
      try {
        setGuardrails(await api.get<GuardrailsView>('getGuardrails'));
      } catch {
        /* 横幅数据失败时保持上次的值 */
      }
    },
    GUARDRAILS_POLL_MS,
    authed && platform.status === 'ok',
  );

  usePoll(
    async () => {
      try {
        const c = await api.get<CatalogView>('getCatalog');
        if (c) {
          setCatalog(c);
          setFirstCatalog((f) => f ?? c.catalogVersion);
        }
      } catch {
        /* 目录未发布时（404）不显示横幅 */
      }
    },
    CATALOG_POLL_MS,
    authed && platform.status === 'ok',
  );

  usePoll(
    async () => {
      try {
        setManual(await api.get<ManualResourcesView>('listManualResources'));
      } catch {
        /* 同上 */
      }
    },
    MANUAL_POLL_MS,
    authed && platform.status === 'ok' && (role === 'L' || role === 'A'),
  );

  const indexUrl = catalog?.indexUrl ?? null;
  useEffect(() => {
    if (!indexUrl) return undefined;
    let cancelled = false;
    fetch(indexUrl, { credentials: 'same-origin' })
      .then((r) => (r.ok ? (r.json() as Promise<{ cards?: { id: string; costTier?: { required?: CostTier } }[] }>) : null))
      .then((idx) => {
        if (cancelled || !idx?.cards) return;
        const map: Record<string, CostTier> = {};
        for (const c of idx.cards) if (c.costTier?.required) map[c.id] = c.costTier.required;
        setCostTiers(map);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [indexUrl]);

  const markOnboarded = useCallback(async () => {
    lsSet(STORAGE_KEYS.onboarded, true);
    setLocalOnboarded(true);
    try {
      await api.call('patchMe', { body: { onboarding: { completedAt: new Date().toISOString(), version: '1' } } });
      await refreshMe();
    } catch {
      /* 写不进服务端时本机标记照样生效（§9.2 #4 的降级） */
    }
  }, [api, refreshMe]);

  const value = useMemo<GlobalStatus>(
    () => ({
      platform,
      me,
      meLoaded,
      guardrails,
      catalog,
      catalogUpdatedTo: catalog && firstCatalog && catalog.catalogVersion !== firstCatalog ? catalog.catalogVersion : null,
      manual,
      costTiers,
      onboardingDone: !!me?.onboarding?.completedAt || localOnboarded,
      retryPlatform: () => setPlatformTry((x) => x + 1),
      markOnboarded,
      refreshMe,
    }),
    [platform, me, meLoaded, guardrails, catalog, firstCatalog, manual, costTiers, localOnboarded, markOnboarded, refreshMe],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useGlobalStatus(): GlobalStatus {
  const v = useContext(Ctx);
  if (!v) throw new Error('GlobalStatusProvider is missing');
  return v;
}
