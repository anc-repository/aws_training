/**
 * 应用级服务（每个浏览器标签页一份）：配置、认证、API 客户端、连接状态、服务端时钟、SessionSync、全局错误（P13）。
 * main.tsx 读取 /config.json 后调用 createServices()；测试用 createServices({ … }) 注入假实现。
 */
import { ApiClient, type PendingRequest } from '../api/client';
import { Connectivity } from '../api/connectivity';
import type { ApiError } from '../api/errors';
import { serverClock as defaultClock, type ServerClock } from '../api/serverClock';
import { SessionSync, type VisibilitySource } from '../api/sessionSync';
import { AuthService } from '../auth/authService';
import type { PlatformConfigJson } from '../auth/config';
import type { Channel } from '../lib/broadcast';

/** P13 的全局对话框状态：登录过期（#5）、需要最近登录（#6）。 */
export interface GlobalErrorState {
  authExpired: ApiError | null;
  reauth: { error: ApiError; request: PendingRequest } | null;
}

export class GlobalErrors {
  private snap: GlobalErrorState = { authExpired: null, reauth: null };
  private readonly listeners = new Set<() => void>();
  getSnapshot = (): GlobalErrorState => this.snap;
  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  set(patch: Partial<GlobalErrorState>): void {
    this.snap = { ...this.snap, ...patch };
    for (const l of this.listeners) l();
  }
}

export interface Services {
  config: PlatformConfigJson;
  auth: AuthService;
  api: ApiClient;
  connectivity: Connectivity;
  clock: ServerClock;
  sync: SessionSync;
  errors: GlobalErrors;
}

export interface CreateServicesOptions {
  config: PlatformConfigJson;
  fetchImpl?: typeof fetch;
  clock?: ServerClock;
  /** null = 不使用 BroadcastChannel（测试、单标签页）。 */
  sessionChannel?: Channel | null;
  authChannel?: Channel | null;
  visibility?: VisibilitySource;
  location?: Pick<Location, 'origin' | 'hostname' | 'assign'>;
  connectivityTarget?: Pick<Window, 'addEventListener'> | null;
}

export function createServices(o: CreateServicesOptions): Services {
  const clock = o.clock ?? defaultClock;
  const errors = new GlobalErrors();
  const connectivity = new Connectivity(o.connectivityTarget);
  const auth = new AuthService({ config: o.config, fetchImpl: o.fetchImpl, channel: o.authChannel, location: o.location });
  const api = new ApiClient({
    apiBase: o.config.apiBase,
    tokens: auth,
    fetchImpl: o.fetchImpl,
    hooks: {
      onTransientFailure: (e) => connectivity.reportFailure(e.status >= 500),
      onSuccess: () => connectivity.reportSuccess(),
      onUnauthenticated: (e) => {
        // 只在“使用中”提示登录过期；启动阶段的失败由守卫重定向到 /login?reason=expired
        if (auth.getSnapshot().status === 'authenticated') errors.set({ authExpired: e });
      },
      onReauthRequired: (e, request) => errors.set({ reauth: { error: e, request } }),
    },
  });
  const sync = new SessionSync({ api, clock, channel: o.sessionChannel, visibility: o.visibility });
  // 网络恢复：立即重新对时与刷新（P13 #1）
  let wasOffline = connectivity.snapshot.offline;
  connectivity.subscribe((s) => {
    if (wasOffline && !s.offline) sync.refreshNow();
    wasOffline = s.offline;
  });
  return { config: o.config, auth, api, connectivity, clock, sync, errors };
}
