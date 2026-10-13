// CapabilitiesProvider（总纲 12.2）：渲染路由前加载 /api/capabilities 与模块注册表（加载期间显示骨架屏），
// 之后每 60 秒及窗口重新获得焦点时刷新；管理员在 /lab 页面时改用 SSE（/api/capabilities/stream）实时接收状态变化。
import { createContext, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { CapabilitiesResponse, CapabilityTransitionEvent, RegistryDocument } from '@cloudalbum/contracts';
import { describeError } from '../api/client';
import { getCapabilities } from '../api/endpoints';
import { loadRegistry } from './registry';

export interface CapabilitiesContextValue {
  caps: CapabilitiesResponse | null;
  registry: RegistryDocument | null;
  error: string | null;
  /** 最近一次成功刷新的时间（epoch ms） */
  updatedAt: number;
  refresh(opts?: { deep?: boolean }): Promise<void>;
  /** SSE 推来的完整快照 */
  applySnapshot(next: CapabilitiesResponse): void;
  /** SSE 推来的状态变化事件 */
  applyTransition(e: CapabilityTransitionEvent): void;
  /** SSE 打开期间暂停轮询 */
  setStreaming(on: boolean): void;
}

export const CapabilitiesContext = createContext<CapabilitiesContextValue | null>(null);

export interface CapabilitiesProviderProps {
  children: ReactNode;
  /** 首次加载期间显示的内容（骨架屏） */
  fallback?: ReactNode;
  pollMs?: number;
  /** 测试注入 */
  fetchCapabilities?: (opts?: { deep?: boolean }) => Promise<CapabilitiesResponse>;
  fetchRegistry?: () => Promise<RegistryDocument>;
}

export function applyTransitionTo(caps: CapabilitiesResponse, e: CapabilityTransitionEvent): CapabilitiesResponse {
  const cur = caps.modules[e.module];
  if (!cur) return caps;
  const next = e.field === 'localHealth'
    ? { ...cur, localHealth: e.to === 'off' ? cur.localHealth : e.to, detail: e.detail }
    : { ...cur, status: e.to, detail: e.detail, since: e.at };
  return { ...caps, generatedAt: e.at, modules: { ...caps.modules, [e.module]: next } };
}

export function CapabilitiesProvider({
  children,
  fallback = null,
  pollMs = 60_000,
  fetchCapabilities = getCapabilities,
  fetchRegistry = loadRegistry,
}: CapabilitiesProviderProps) {
  const [caps, setCaps] = useState<CapabilitiesResponse | null>(null);
  const [registry, setRegistry] = useState<RegistryDocument | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState(0);
  const streaming = useRef(0);
  const fetchCapsRef = useRef(fetchCapabilities);
  fetchCapsRef.current = fetchCapabilities;

  const refresh = useCallback(async (opts?: { deep?: boolean }) => {
    try {
      const next = await fetchCapsRef.current(opts);
      setCaps(next);
      setError(null);
      setUpdatedAt(Date.now());
    } catch (e) {
      setError(describeError(e));
    }
  }, []);

  // 首次加载：capabilities 与注册表并行
  useEffect(() => {
    let cancelled = false;
    void Promise.allSettled([fetchCapsRef.current(), fetchRegistry()]).then(([c, r]) => {
      if (cancelled) return;
      if (r.status === 'fulfilled') setRegistry(r.value);
      if (c.status === 'fulfilled') {
        setCaps(c.value);
        setUpdatedAt(Date.now());
      } else {
        setError(describeError(c.reason));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [fetchRegistry]);

  // 每 60 秒与窗口重新获得焦点时刷新（SSE 打开期间暂停）
  useEffect(() => {
    if (!pollMs) return undefined;
    const tick = () => {
      if (streaming.current > 0) return;
      if (globalThis.document?.visibilityState === 'hidden') return;
      void refresh();
    };
    const timer = setInterval(tick, pollMs);
    const onFocus = () => tick();
    globalThis.addEventListener?.('focus', onFocus);
    return () => {
      clearInterval(timer);
      globalThis.removeEventListener?.('focus', onFocus);
    };
  }, [pollMs, refresh]);

  const applySnapshot = useCallback((next: CapabilitiesResponse) => {
    setCaps(next);
    setUpdatedAt(Date.now());
  }, []);
  const applyTransition = useCallback((e: CapabilityTransitionEvent) => {
    setCaps((cur) => (cur ? applyTransitionTo(cur, e) : cur));
    setUpdatedAt(Date.now());
  }, []);
  const setStreaming = useCallback((on: boolean) => {
    streaming.current = Math.max(0, streaming.current + (on ? 1 : -1));
  }, []);

  const value = useMemo<CapabilitiesContextValue>(
    () => ({ caps, registry, error, updatedAt, refresh, applySnapshot, applyTransition, setStreaming }),
    [caps, registry, error, updatedAt, refresh, applySnapshot, applyTransition, setStreaming],
  );

  if (!caps) {
    return (
      <CapabilitiesContext.Provider value={value}>
        {error ? <CapabilitiesError message={error} onRetry={() => void refresh()} /> : fallback}
      </CapabilitiesContext.Provider>
    );
  }
  return <CapabilitiesContext.Provider value={value}>{children}</CapabilitiesContext.Provider>;
}

function CapabilitiesError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="boot">
      <div className="card" role="alert">
        <h1>无法读取 /api/capabilities</h1>
        <p className="muted">前端需要它才能知道登录方式、上传方式与各模块的状态（总纲 12.1：前端不猜）。</p>
        <p className="mono wrap-any">{message}</p>
        <button type="button" className="btn btn-primary" onClick={onRetry}>重试</button>
      </div>
    </div>
  );
}

export function BootSkeleton() {
  return (
    <div className="boot" aria-busy="true" aria-label="正在加载">
      <div className="skeleton" style={{ height: 28, width: 220, marginBottom: 16 }} />
      <div className="grid-photos">
        {Array.from({ length: 8 }, (_, i) => (
          <div key={i} className="skeleton" style={{ aspectRatio: '1 / 1' }} />
        ))}
      </div>
    </div>
  );
}
