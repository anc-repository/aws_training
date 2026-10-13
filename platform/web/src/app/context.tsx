/**
 * React 上下文与订阅 hooks：组件只通过这些 hooks 读取认证、会话同步、连接状态与服务端时间，不各自轮询（08 §2.6“状态”）。
 */
import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { ConnectivitySnapshot } from '../api/connectivity';
import type { SessionEvent, SessionView } from '../api/types';
import type { SessionSyncSnapshot } from '../api/sessionSync';
import type { AuthSnapshot } from '../auth/authService';
import type { GlobalErrorState, Services } from './services';

const ServicesContext = createContext<Services | null>(null);

export function ServicesProvider({ services, children }: { services: Services; children: ReactNode }) {
  return <ServicesContext.Provider value={services}>{children}</ServicesContext.Provider>;
}

export function useServices(): Services {
  const s = useContext(ServicesContext);
  if (!s) throw new Error('ServicesProvider is missing');
  return s;
}

export function useAuth(): AuthSnapshot {
  const { auth } = useServices();
  return useSyncExternalStore(auth.subscribe, auth.getSnapshot);
}

export function useSessionSync(): SessionSyncSnapshot {
  const { sync } = useServices();
  return useSyncExternalStore(sync.subscribe, sync.getSnapshot);
}

/** 当前会话（GET /sessions/current；没有时 null）。 */
export function useCurrentSession(): { current: SessionView | null; loaded: boolean } {
  const s = useSessionSync();
  return { current: s.current, loaded: s.currentLoaded };
}

/** 订阅某个会话：组件挂载期间由 SessionSync 轮询它的视图与事件。 */
export function useWatchedSession(sid: string | undefined): SessionView | null {
  const { sync } = useServices();
  const snap = useSessionSync();
  useEffect(() => (sid ? sync.watch(sid) : undefined), [sync, sid]);
  return sid ? (snap.views[sid] ?? null) : null;
}

/** 订阅新到达的会话事件（按类型或前缀过滤，§7.5）。 */
export function useSessionEvents(
  handler: (sid: string, events: readonly SessionEvent[]) => void,
  filter?: { sid?: string; types?: readonly string[]; prefixes?: readonly string[] },
): void {
  const { sync } = useServices();
  const key = JSON.stringify(filter ?? {});
  const [h] = useState(() => ({ current: handler }));
  h.current = handler;
  useEffect(() => sync.onEvents((sid, ev) => h.current(sid, ev), JSON.parse(key) as typeof filter), [sync, key, h]);
}

export function useConnectivity(): ConnectivitySnapshot {
  const { connectivity } = useServices();
  return useSyncExternalStore(
    (l) => connectivity.subscribe(() => l()),
    () => connectivity.snapshot,
  );
}

export function useGlobalErrors(): GlobalErrorState {
  const { errors } = useServices();
  return useSyncExternalStore(errors.subscribe, errors.getSnapshot);
}
