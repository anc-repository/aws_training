/**
 * 画面级的小型数据源（08 §2.6“服务端数据用查询缓存”）：一个读取函数 + 可选的定时刷新（页面隐藏时暂停）+ 手动刷新。
 * 会话视图与事件仍由 SessionSync 统一维护（组件不得自行轮询会话接口），这里只用于工作台的其他读取接口。
 * 刷新失败时保留上一次的数据（局部错误，§4.0），不清空界面。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { isApiError, type ApiError } from '../../api/errors';

export interface Resource<T> {
  data: T | null;
  error: ApiError | Error | null;
  loading: boolean;
  /** 首次加载已完成（成功或失败）。 */
  loaded: boolean;
  refresh: () => Promise<void>;
}

export interface ResourceOptions {
  enabled?: boolean;
  /** 定时刷新间隔（页面隐藏时暂停，回到前台立即刷新）。 */
  intervalMs?: number | null;
}

export function useResource<T>(key: string | null, fetcher: () => Promise<T | null>, opts: ResourceOptions = {}): Resource<T> {
  const enabled = opts.enabled !== false && key !== null;
  const [state, setState] = useState<{ key: string | null; data: T | null; error: ApiError | Error | null; loading: boolean; loaded: boolean }>({
    key,
    data: null,
    error: null,
    loading: enabled,
    loaded: false,
  });
  const fetchRef = useRef(fetcher);
  fetchRef.current = fetcher;
  const seq = useRef(0);
  const keyRef = useRef(key);
  keyRef.current = key;

  const refresh = useCallback(async () => {
    if (!enabled) return;
    const my = ++seq.current;
    const k = keyRef.current;
    setState((s) => (s.key === k ? { ...s, loading: true } : { key: k, data: null, error: null, loading: true, loaded: false }));
    try {
      const data = await fetchRef.current();
      if (my !== seq.current) return;
      setState({ key: k, data, error: null, loading: false, loaded: true });
    } catch (e) {
      if (my !== seq.current) return;
      setState((s) => ({ key: k, data: s.key === k ? s.data : null, error: isApiError(e) || e instanceof Error ? e : new Error(String(e)), loading: false, loaded: true }));
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return undefined;
    void refresh();
    return undefined;
  }, [key, enabled, refresh]);

  const interval = opts.intervalMs ?? null;
  useEffect(() => {
    if (!enabled || !interval) return undefined;
    const id = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      void refresh();
    }, interval);
    const onVis = () => {
      if (!document.hidden) void refresh();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [enabled, interval, refresh]);

  const current = state.key === key;
  return { data: current ? state.data : null, error: current ? state.error : null, loading: current ? state.loading : enabled, loaded: current && state.loaded, refresh };
}
