/**
 * 一次用户操作（08 §7.6 第 3 条、P13 #6、#19）：
 * - 同一次操作的重试复用同一个 Idempotency-Key（`retry()`）；新的一次点击生成新键（`run()`）；
 * - 状态冲突 / 版本冲突（409 INVALID_STATE、412）→ 立即补拉会话视图，界面按新状态重绘，不弹错误框；
 * - 需要最近登录（403 REAUTH_REQUIRED）由全局 ReauthDialog 处理；`replay: true` 时挂载后取回 15 分钟内保存的原请求并重放；
 * - 结果只在服务端确认后写入（不做乐观更新，§7.6 第 2 条）。
 */
import type { RouteId } from '@atl/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiResponse, CallOptions } from '../../api/client';
import { isApiError, type ApiError } from '../../api/errors';
import { useServices } from '../../app/context';
import { takeReauthReplay } from '../../components/GlobalDialogs';
import { uuidV4 } from '../../lib/uuid';
import { describeProblem } from './problems';

export interface UseActionOptions<T> {
  /** 会话修改类操作：冲突时补拉这个会话的视图。 */
  sid?: string;
  onSuccess?: (data: T | null, res: ApiResponse<T>) => void;
  /** 挂载时重放“需要最近登录”之前保存的同一路由的请求。 */
  replay?: boolean;
}

export interface ActionHandle<T> {
  busy: boolean;
  error: ApiError | null;
  data: T | null;
  /** 新的一次操作（新的 Idempotency-Key）。 */
  run: (opts?: Omit<CallOptions, 'idempotencyKey'>) => Promise<ApiResponse<T> | null>;
  /** 重试上一次操作（同一个 Idempotency-Key、同样的参数）。 */
  retry: () => Promise<ApiResponse<T> | null>;
  reset: () => void;
}

export function useAction<T = unknown>(routeId: RouteId, opts: UseActionOptions<T> = {}): ActionHandle<T> {
  const { api, sync } = useServices();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [data, setData] = useState<T | null>(null);
  const keyRef = useRef<string | null>(null);
  const lastOpts = useRef<Omit<CallOptions, 'idempotencyKey'>>({});
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const exec = useCallback(
    async (callOpts: Omit<CallOptions, 'idempotencyKey'>, key: string | null, replayed?: Parameters<typeof api.replay>[0]): Promise<ApiResponse<T> | null> => {
      setBusy(true);
      setError(null);
      try {
        const res = replayed ? await api.replay<T>(replayed) : await api.call<T>(routeId, { ...callOpts, ...(key ? { idempotencyKey: key } : {}) });
        if (!mounted.current) return res;
        setData(res.data);
        setBusy(false);
        optsRef.current.onSuccess?.(res.data, res);
        return res;
      } catch (e) {
        if (!isApiError(e)) throw e;
        if (!mounted.current) return null;
        setBusy(false);
        setError(e);
        const p = describeProblem(e);
        const sid = optsRef.current.sid;
        if (p?.refreshView && sid) void sync.refreshView(sid);
        return null;
      }
    },
    [api, routeId, sync],
  );

  const run = useCallback(
    (callOpts: Omit<CallOptions, 'idempotencyKey'> = {}) => {
      keyRef.current = uuidV4();
      lastOpts.current = callOpts;
      return exec(callOpts, keyRef.current);
    },
    [exec],
  );

  const retry = useCallback(() => exec(lastOpts.current, keyRef.current ?? uuidV4()), [exec]);
  const reset = useCallback(() => {
    setError(null);
    setData(null);
  }, []);

  useEffect(() => {
    if (!optsRef.current.replay) return;
    const req = takeReauthReplay(routeId);
    if (req) {
      keyRef.current = req.opts.idempotencyKey ?? null;
      lastOpts.current = req.opts;
      void exec(req.opts, keyRef.current, req);
    }
  }, [exec, routeId]);

  return { busy, error, data, run, retry, reset };
}
