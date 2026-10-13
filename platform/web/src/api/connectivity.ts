/**
 * 连接状态（08 P13 #1、#2、页脚“实时 ● 轮询中 / ○ 已暂停 / ✕ 连接中断”）。
 * 离线 = navigator.onLine 为 false，或连续 3 次请求出现网络错误 / 5xx；任意一次成功即恢复。
 * ApiClient 的 hooks 把结果喂给 reportFailure() / reportSuccess()；OfflineBar 与页脚订阅 snapshot。
 */

export interface ConnectivitySnapshot {
  offline: boolean;
  /** 连续失败次数（网络错误或 5xx）。 */
  failures: number;
  /** 最近一次的失败是否为 5xx（平台服务暂时不可用，P13 #2）。 */
  serverError: boolean;
}

type Listener = (s: ConnectivitySnapshot) => void;

export const OFFLINE_AFTER_FAILURES = 3;

export class Connectivity {
  private snap: ConnectivitySnapshot = { offline: false, failures: 0, serverError: false };
  private readonly listeners = new Set<Listener>();
  private browserOffline = false;

  constructor(target: Pick<Window, 'addEventListener'> | null = typeof window !== 'undefined' ? window : null) {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) this.browserOffline = true;
    target?.addEventListener('online', () => {
      this.browserOffline = false;
      this.update({});
    });
    target?.addEventListener('offline', () => {
      this.browserOffline = true;
      this.update({});
    });
    this.update({});
  }

  get snapshot(): ConnectivitySnapshot {
    return this.snap;
  }

  reportFailure(serverError: boolean): void {
    this.update({ failures: this.snap.failures + 1, serverError });
  }

  reportSuccess(): void {
    if (this.snap.failures === 0 && !this.snap.offline) return;
    this.update({ failures: 0, serverError: false });
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private update(patch: Partial<ConnectivitySnapshot>): void {
    const next = { ...this.snap, ...patch };
    next.offline = this.browserOffline || next.failures >= OFFLINE_AFTER_FAILURES;
    this.snap = next;
    for (const l of this.listeners) l(next);
  }
}
