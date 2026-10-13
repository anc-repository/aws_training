// 读取型请求的小钩子：传入稳定的 loader（useCallback），返回 data / error / loading / reload。
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, describeError } from '../api/client';

export interface AsyncState<T> {
  data: T | undefined;
  error: string | null;
  /** 原始错误（判断 501 / 403 等） */
  errorObj: unknown;
  loading: boolean;
  reload: () => Promise<void>;
  setData: (updater: T | ((cur: T | undefined) => T | undefined)) => void;
}

export function useAsync<T>(loader: () => Promise<T>, opts: { enabled?: boolean } = {}): AsyncState<T> {
  const enabled = opts.enabled ?? true;
  const [data, setDataState] = useState<T | undefined>(undefined);
  const [errorObj, setErrorObj] = useState<unknown>(null);
  const [loading, setLoading] = useState(enabled);
  const seq = useRef(0);

  const run = useCallback(async () => {
    const my = ++seq.current;
    setLoading(true);
    try {
      const v = await loader();
      if (my !== seq.current) return;
      setDataState(v);
      setErrorObj(null);
    } catch (e) {
      if (my !== seq.current) return;
      setErrorObj(e);
    } finally {
      if (my === seq.current) setLoading(false);
    }
  }, [loader]);

  useEffect(() => {
    if (!enabled) return undefined;
    void run();
    return () => {
      seq.current += 1;
    };
  }, [run, enabled]);

  const setData = useCallback((updater: T | ((cur: T | undefined) => T | undefined)) => {
    setDataState((cur) => (typeof updater === 'function' ? (updater as (c: T | undefined) => T | undefined)(cur) : updater));
  }, []);

  return { data, error: errorObj ? describeError(errorObj) : null, errorObj, loading, reload: run, setData };
}

export function isStatus(e: unknown, status: number): boolean {
  return e instanceof ApiError && e.status === status;
}
