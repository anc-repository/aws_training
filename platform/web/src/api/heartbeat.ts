/**
 * 工作台心跳（08 §7.2 第 9 条、D-UI-11）：每个**可见的工作台标签页**各自发送 `POST /sessions/{sid}/heartbeat {workbench: true}`，
 * 不受主标签页选举限制。首次进入工作台时立即同步发送一次，之后页面可见时每 60 秒一次；页面隐藏时不发，回到前台立即补发。
 * `READY → RUNNING` 只靠这次心跳触发（02 §2.3 T07）。响应中的 serverNow、deadlineAt、deadlineVersion 更新视图并广播（SessionSync.applyHeartbeat）。
 * 只对学员（L）启动：心跳路由的鉴权是 L（01 §8.2）。
 */
import type { ApiClient } from './client';
import type { SessionSync, VisibilitySource } from './sessionSync';
import { documentVisibility } from './sessionSync';
import type { HeartbeatResult } from './types';

export const HEARTBEAT_MS = 60_000;

export interface WorkbenchHeartbeatOptions {
  api: Pick<ApiClient, 'call'>;
  sync: Pick<SessionSync, 'applyHeartbeat'>;
  sid: string;
  visibility?: VisibilitySource;
  wallNow?: () => number;
}

export class WorkbenchHeartbeat {
  private timer: ReturnType<typeof setInterval> | null = null;
  private unsub: (() => void) | null = null;
  private inflight = false;
  private readonly visibility: VisibilitySource;
  private readonly wallNow: () => number;

  constructor(private readonly opts: WorkbenchHeartbeatOptions) {
    this.visibility = opts.visibility ?? documentVisibility;
    this.wallNow = opts.wallNow ?? (() => Date.now());
  }

  start(): void {
    if (this.timer) return;
    void this.beat();
    this.timer = setInterval(() => {
      if (this.visibility.isVisible()) void this.beat();
    }, HEARTBEAT_MS);
    this.unsub = this.visibility.subscribe(() => {
      if (this.visibility.isVisible()) void this.beat();
    });
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.unsub?.();
    this.unsub = null;
  }

  async beat(): Promise<HeartbeatResult | null> {
    if (this.inflight || !this.visibility.isVisible()) return null;
    this.inflight = true;
    const sentAt = this.wallNow();
    try {
      const r = await this.opts.api.call<HeartbeatResult>('heartbeat', { params: { sid: this.opts.sid }, body: { workbench: true } });
      if (r.data) this.opts.sync.applyHeartbeat(this.opts.sid, r.data, sentAt, this.wallNow());
      return r.data;
    } catch {
      return null;
    } finally {
      this.inflight = false;
    }
  }
}
