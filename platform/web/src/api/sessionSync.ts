/**
 * SessionSync：全站唯一的会话同步器（08 §7.1～§7.6）。所有画面通过订阅获得会话视图与事件，组件不得自行轮询会话接口。
 *
 * 1. 主标签页选举：BroadcastChannel('atl-session')，先到先得 + 选举心跳 5 秒；主标签页关闭、或隐藏 15 秒且有其他可见标签页时，
 *    由可见的标签页接管；冲突时 id 小的保留。其他标签页通过广播接收会话视图与事件。不支持 BroadcastChannel 时每个标签页
 *    各自轮询，间隔加倍（P13 #30）。会话心跳不归主标签页管（见 heartbeat.ts）。
 * 2. 当前会话：启动时、每次 `session.state_changed` 后、当前会话进入终态后调用 `GET /sessions/current`（204 = 没有）；
 *    没有当前会话时每 60 秒检查一次。
 * 3. 游标：每个 sid 的游标存 sessionStorage `atl.events.<sid>`，刷新后从游标继续；首次不带 after，按页消费直到没有更多；
 *    界面只拿到最近 200 条。从广播收到的事件同样推进本标签页的游标（接管后无缝继续）。
 * 4. 去重与乱序：按事件 id（ULID）去重、排序后应用；会话视图 `ver` 小于已持有的 `ver` 时丢弃（迟到的响应）。
 * 5. 事件只用于及时与细节，权威状态以会话视图为准：收到任何 `session.*` 事件立即补拉一次会话视图。
 * 6. 间隔：事件用服务端的 `pollAfterMs`；会话视图按 08 §7.3（viewIntervalMs）；两者各自计时。
 * 7. 可见性：所有标签页都隐藏时主标签页改为 60 秒低频；回到前台立即对时、拉视图与事件。
 * 8. 失败退避 1、2、4、8…秒，上限 60 秒；连续失败由 Connectivity 显示离线条（P13 #1）。
 * 事件游标失效（任何 4xx）：丢弃游标，从头重建（P13 #32、§9.2 #22）。
 */
import { isTerminal, type SessionState } from '@atl/shared';
import { STORAGE_KEYS, ssGet, ssSet } from '../lib/storage';
import { openChannel, type Channel } from '../lib/broadcast';
import type { ApiClient } from './client';
import { isApiError, type ApiError } from './errors';
import { ServerClock } from './serverClock';
import type { EventsPage, HeartbeatResult, SessionEvent, SessionView } from './types';

export const CHANNEL_NAME = 'atl-session';
export const MAX_UI_EVENTS = 200;
export const PRESENCE_MS = 5_000;
export const TAKEOVER_MS = 15_000;
export const ELECTION_WAIT_MS = 1_200;
export const LOW_FREQ_MS = 60_000;
export const NO_SESSION_POLL_MS = 60_000;
export const BACKOFF_MAX_MS = 60_000;

// ---------------------------------------------------------------------------------------------------------------
// 轮询节奏（08 §7.3）

export interface IntervalContext {
  /** 服务端当前时间。 */
  nowMs: number;
  /** 所有标签页都在后台。 */
  allHidden: boolean;
  /** 没有 BroadcastChannel：间隔加倍。 */
  solo: boolean;
  /** 有画面显式订阅了这个会话（例如 P07 查看已结束会话的复扫）。 */
  explicit: boolean;
}

function baseViewInterval(view: SessionView, ctx: IntervalContext): number | null {
  const remaining = view.deadlineAt ? Date.parse(view.deadlineAt) - ctx.nowMs : null;
  switch (view.state) {
    case 'REQUESTED':
    case 'PROVISIONING':
      return 5_000;
    case 'READY':
    case 'RUNNING':
      // P13 #18：本地剩余时间为 0 但服务端仍未结束时加快到 5 秒
      return remaining !== null && remaining <= 0 ? 5_000 : 30_000;
    case 'EXPIRING':
      return remaining !== null && remaining < 60_000 ? 5_000 : 10_000;
    case 'ENDING':
    case 'CLEANING':
      return 10_000;
    case 'KEPT':
    case 'CLEANUP_FAILED':
      return 60_000;
    default:
      return ctx.explicit ? 60_000 : null;
  }
}

/** 会话视图的轮询间隔；null = 停止。 */
export function viewIntervalMs(view: SessionView | null, ctx: IntervalContext): number | null {
  if (!view) return ctx.allHidden ? LOW_FREQ_MS : 5_000;
  let ms = baseViewInterval(view, ctx);
  if (ms === null) return null;
  if (ctx.allHidden) ms = LOW_FREQ_MS;
  return ctx.solo ? ms * 2 : ms;
}

/** 事件轮询间隔；`hasMore` 时立即取下一页；null = 停止。 */
export function eventsIntervalMs(view: SessionView | null, page: Pick<EventsPage, 'hasMore' | 'pollAfterMs'> | null, ctx: IntervalContext): number | null {
  if (page?.hasMore) return 0;
  if (view && isTerminal(view.state) && !ctx.explicit) return null;
  let ms: number;
  if (ctx.allHidden) ms = LOW_FREQ_MS;
  else if (view && (view.state === 'KEPT' || view.state === 'CLEANUP_FAILED')) ms = Math.max(page?.pollAfterMs ?? 0, 60_000);
  else ms = page?.pollAfterMs ?? (view ? (baseViewInterval(view, ctx) ?? 60_000) : 5_000);
  return ctx.solo ? ms * 2 : ms;
}

export function nextBackoffMs(prev: number): number {
  return prev <= 0 ? 1_000 : Math.min(BACKOFF_MAX_MS, prev * 2);
}

/** 会话状态类事件：到达后立即补拉会话视图（§7.2 第 5 条）。 */
export function isSessionScopedEvent(type: string): boolean {
  return type.startsWith('session.');
}

/** 合并事件：按 id 去重、排序，保留最近 max 条；返回合并结果与真正新增的事件。 */
export function mergeEvents(existing: readonly SessionEvent[], seen: Set<string>, incoming: readonly SessionEvent[], max = MAX_UI_EVENTS) {
  const fresh = incoming.filter((e) => e && typeof e.id === 'string' && !seen.has(e.id));
  for (const e of fresh) seen.add(e.id);
  fresh.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const merged = [...existing, ...fresh].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { events: merged.length > max ? merged.slice(merged.length - max) : merged, fresh };
}

// ---------------------------------------------------------------------------------------------------------------

export interface VisibilitySource {
  isVisible(): boolean;
  subscribe(cb: () => void): () => void;
}

export const documentVisibility: VisibilitySource = {
  isVisible: () => typeof document === 'undefined' || document.visibilityState !== 'hidden',
  subscribe: (cb) => {
    if (typeof document === 'undefined') return () => undefined;
    document.addEventListener('visibilitychange', cb);
    return () => document.removeEventListener('visibilitychange', cb);
  },
};

export interface CursorStore {
  get(sid: string): string | null;
  set(sid: string, cursor: string | null): void;
}

export const sessionStorageCursors: CursorStore = {
  get: (sid) => ssGet<string | null>(STORAGE_KEYS.eventsCursorPrefix + sid, null),
  set: (sid, cursor) => {
    ssSet(STORAGE_KEYS.eventsCursorPrefix + sid, cursor ?? undefined);
  },
};

export interface SessionSyncSnapshot {
  current: SessionView | null;
  /** `GET /sessions/current` 至少成功过一次（或从主标签页收到过）。 */
  currentLoaded: boolean;
  currentError: ApiError | null;
  views: Readonly<Record<string, SessionView>>;
  leader: boolean;
}

export type EventListener = (sid: string, events: readonly SessionEvent[]) => void;

export interface SessionSyncOptions {
  api: Pick<ApiClient, 'call'>;
  clock: ServerClock;
  channel?: Channel | null;
  visibility?: VisibilitySource;
  cursors?: CursorStore;
  /** 本地墙钟（定时与选举用）。 */
  wallNow?: () => number;
  tabId?: string;
}

interface SidState {
  sid: string;
  events: SessionEvent[];
  seen: Set<string>;
  cursor: string | null;
  lastPage: EventsPage | null;
  viewTimer: ReturnType<typeof setTimeout> | null;
  eventsTimer: ReturnType<typeof setTimeout> | null;
  viewBackoff: number;
  eventsBackoff: number;
  viewInflight: boolean;
  eventsInflight: boolean;
}

type Msg =
  | { t: 'presence'; id: string; visible: boolean; leader: boolean; watching: string[] }
  | { t: 'yield'; id: string }
  | { t: 'bye'; id: string }
  | { t: 'current'; id: string; view: SessionView | null }
  | { t: 'view'; id: string; view: SessionView }
  | { t: 'events'; id: string; sid: string; events: SessionEvent[] };

interface Peer {
  visible: boolean;
  leader: boolean;
  watching: string[];
  seenAt: number;
}

export class SessionSync {
  private readonly api: Pick<ApiClient, 'call'>;
  private readonly clock: ServerClock;
  private readonly channel: Channel | null;
  private readonly visibility: VisibilitySource;
  private readonly cursors: CursorStore;
  private readonly wallNow: () => number;
  readonly tabId: string;

  private snap: SessionSyncSnapshot = { current: null, currentLoaded: false, currentError: null, views: {}, leader: false };
  private readonly listeners = new Set<() => void>();
  private readonly eventListeners = new Set<EventListener>();
  private readonly sids = new Map<string, SidState>();
  private readonly localWatch = new Map<string, number>();
  private readonly peers = new Map<string, Peer>();
  private started = false;
  private leader = false;
  private hiddenSince: number | null = null;
  private lastLeaderSeen = 0;
  private presenceTimer: ReturnType<typeof setInterval> | null = null;
  private electionTimer: ReturnType<typeof setTimeout> | null = null;
  private currentTimer: ReturnType<typeof setTimeout> | null = null;
  private currentBackoff = 0;
  private currentInflight: Promise<void> | null = null;
  private unsubVisibility: (() => void) | null = null;

  constructor(opts: SessionSyncOptions) {
    this.api = opts.api;
    this.clock = opts.clock;
    this.channel = opts.channel === undefined ? openChannel(CHANNEL_NAME) : opts.channel;
    this.visibility = opts.visibility ?? documentVisibility;
    this.cursors = opts.cursors ?? sessionStorageCursors;
    this.wallNow = opts.wallNow ?? (() => Date.now());
    this.tabId = opts.tabId ?? `${this.wallNow().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  // ------------------------------------------------------------------------------------------------ public API

  start(): void {
    if (this.started) return;
    this.started = true;
    this.unsubVisibility = this.visibility.subscribe(() => this.onVisibilityChange());
    if (!this.channel) {
      this.becomeLeader();
      return;
    }
    this.channel.onmessage = (ev) => this.onMessage(ev.data as Msg);
    this.sendPresence();
    this.presenceTimer = setInterval(() => this.presenceTick(), PRESENCE_MS);
    this.electionTimer = setTimeout(() => {
      this.electionTimer = null;
      if (!this.hasLiveLeader()) this.becomeLeader();
    }, ELECTION_WAIT_MS);
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    if (this.leader) this.post({ t: 'bye', id: this.tabId });
    this.leader = false;
    this.clearAllTimers();
    if (this.presenceTimer) clearInterval(this.presenceTimer);
    if (this.electionTimer) clearTimeout(this.electionTimer);
    this.presenceTimer = null;
    this.electionTimer = null;
    this.unsubVisibility?.();
    this.unsubVisibility = null;
    if (this.channel) this.channel.onmessage = null;
  }

  /** 停止并关闭广播通道（页面卸载）。 */
  dispose(): void {
    this.stop();
    this.channel?.close();
  }

  getSnapshot = (): SessionSyncSnapshot => this.snap;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** 订阅新到达的事件（已去重、排序）。filter 可按 sid、类型或前缀过滤。 */
  onEvents(listener: EventListener, filter?: { sid?: string; types?: readonly string[]; prefixes?: readonly string[] }): () => void {
    const wrapped: EventListener = (sid, events) => {
      if (filter?.sid && filter.sid !== sid) return;
      const out = filter?.types || filter?.prefixes ? events.filter((e) => filter.types?.includes(e.type) || filter.prefixes?.some((p) => e.type.startsWith(p))) : events;
      if (out.length) listener(sid, out);
    };
    this.eventListeners.add(wrapped);
    return () => this.eventListeners.delete(wrapped);
  }

  /** 最近的事件（最多 200 条，按 id 升序）。 */
  recentEvents(sid: string): readonly SessionEvent[] {
    return this.sids.get(sid)?.events ?? [];
  }

  /** 画面显式订阅一个会话（工作台、回收进度、会话详情）。返回取消函数。 */
  watch(sid: string): () => void {
    this.localWatch.set(sid, (this.localWatch.get(sid) ?? 0) + 1);
    this.ensureSid(sid);
    if (this.leader) this.syncPollers();
    else this.sendPresence();
    return () => {
      const n = (this.localWatch.get(sid) ?? 1) - 1;
      if (n <= 0) this.localWatch.delete(sid);
      else this.localWatch.set(sid, n);
      if (this.leader) this.syncPollers();
      else this.sendPresence();
    };
  }

  /** 立即重新发现当前会话（开始实验之后、state_changed 之后）。 */
  refreshCurrent(): Promise<void> {
    if (!this.leader) return Promise.resolve();
    if (this.currentInflight) return this.currentInflight;
    if (this.currentTimer) clearTimeout(this.currentTimer);
    this.currentTimer = null;
    this.currentInflight = this.fetchCurrent().finally(() => {
      this.currentInflight = null;
    });
    return this.currentInflight;
  }

  /** 立即补拉一个会话的视图。 */
  refreshView(sid: string): Promise<void> {
    const st = this.ensureSid(sid);
    if (!this.leader) return Promise.resolve();
    if (st.viewTimer) clearTimeout(st.viewTimer);
    st.viewTimer = null;
    return this.fetchView(st);
  }

  /** 写操作返回的会话视图（`202` 等）直接并入（乐观更新只用于本地偏好，这里是服务端确认的视图，§7.6 第 2 条）。 */
  applyView(view: SessionView): void {
    if (this.mergeView(view) && this.leader) {
      this.post({ t: 'view', id: this.tabId, view });
      this.syncPollers();
    }
  }

  /** 心跳响应：更新对时与截止时间，并广播（§7.2 第 9 条）。 */
  applyHeartbeat(sid: string, hb: HeartbeatResult, sentAt: number, receivedAt: number): void {
    this.clock.observe(hb.serverNow, sentAt, receivedAt);
    const cur = this.snap.views[sid];
    if (!cur || hb.ver < cur.ver) return;
    const view: SessionView = { ...cur, state: hb.state, ver: hb.ver, deadlineAt: hb.deadlineAt, deadlineVersion: hb.deadlineVersion, serverNow: hb.serverNow };
    if (this.mergeView(view)) this.post({ t: 'view', id: this.tabId, view });
    if (hb.ver > cur.ver) void this.refreshView(sid);
  }

  /** 回到前台、网络恢复：立即对时并刷新。 */
  refreshNow(): void {
    if (!this.leader) {
      this.sendPresence();
      return;
    }
    void this.syncTime();
    void this.refreshCurrent();
    for (const st of this.sids.values()) {
      if (!this.shouldPoll(st.sid)) continue;
      void this.fetchView(st);
      void this.fetchEvents(st);
    }
  }

  get isLeader(): boolean {
    return this.leader;
  }

  // ------------------------------------------------------------------------------------------------ election

  private post(msg: Msg): void {
    try {
      this.channel?.postMessage(msg);
    } catch {
      /* 广播失败不影响本标签页 */
    }
  }

  private sendPresence(): void {
    this.post({ t: 'presence', id: this.tabId, visible: this.visibility.isVisible(), leader: this.leader, watching: [...this.localWatch.keys()] });
  }

  private livePeers(): [string, Peer][] {
    const now = this.wallNow();
    return [...this.peers.entries()].filter(([, p]) => now - p.seenAt <= TAKEOVER_MS);
  }

  /** 15 秒内收到过主标签页的选举心跳或广播。 */
  private hasLiveLeader(): boolean {
    if (this.lastLeaderSeen && this.wallNow() - this.lastLeaderSeen <= TAKEOVER_MS) return true;
    return this.livePeers().some(([, p]) => p.leader);
  }

  private presenceTick(): void {
    this.sendPresence();
    const now = this.wallNow();
    const visible = this.visibility.isVisible();
    if (this.leader) {
      // 隐藏 15 秒且有其他可见标签页：交出主标签页身份
      if (!visible && this.hiddenSince !== null && now - this.hiddenSince >= TAKEOVER_MS && this.livePeers().some(([, p]) => p.visible)) {
        this.becomeFollower();
        this.post({ t: 'yield', id: this.tabId });
      } else {
        this.syncPollers();
      }
      return;
    }
    // 主标签页 15 秒没有消息，或隐藏的主标签页交出后：由可见的标签页接管（id 小的优先）
    if (visible && now - this.lastLeaderSeen > TAKEOVER_MS && !this.hasLiveLeader() && this.isPreferredCandidate()) this.becomeLeader();
  }

  private isPreferredCandidate(): boolean {
    return !this.livePeers().some(([id, p]) => p.visible && id < this.tabId);
  }

  private onMessage(msg: Msg): void {
    if (!msg || typeof msg !== 'object' || msg.id === this.tabId) return;
    const now = this.wallNow();
    switch (msg.t) {
      case 'presence': {
        const known = this.peers.has(msg.id);
        this.peers.set(msg.id, { visible: msg.visible, leader: msg.leader, watching: msg.watching ?? [], seenAt: now });
        // 新标签页：主标签页立即宣告自己，并把当前会话与已有视图发给它
        if (this.leader && !known) {
          this.sendPresence();
          if (this.snap.currentLoaded) this.post({ t: 'current', id: this.tabId, view: this.snap.current });
          for (const v of Object.values(this.snap.views)) this.post({ t: 'view', id: this.tabId, view: v });
        }
        if (msg.leader) {
          this.lastLeaderSeen = now;
          if (this.leader && msg.id < this.tabId) this.becomeFollower();
        }
        if (this.leader) this.syncPollers();
        break;
      }
      case 'yield':
      case 'bye': {
        const p = this.peers.get(msg.id);
        if (msg.t === 'bye') this.peers.delete(msg.id);
        else if (p) p.leader = false;
        this.lastLeaderSeen = 0;
        if (!this.leader && this.visibility.isVisible() && this.isPreferredCandidate()) this.becomeLeader();
        break;
      }
      case 'current':
        this.lastLeaderSeen = now;
        this.setCurrent(msg.view, true);
        break;
      case 'view':
        this.lastLeaderSeen = now;
        this.mergeView(msg.view);
        break;
      case 'events': {
        this.lastLeaderSeen = now;
        const st = this.ensureSid(msg.sid);
        this.acceptEvents(st, msg.events);
        break;
      }
    }
  }

  private becomeLeader(): void {
    if (this.leader || !this.started) return;
    this.leader = true;
    this.hiddenSince = this.visibility.isVisible() ? null : this.wallNow();
    this.setSnap({ leader: true });
    this.sendPresence();
    void this.syncTime();
    void this.refreshCurrent();
    this.syncPollers();
  }

  private becomeFollower(): void {
    if (!this.leader) return;
    this.leader = false;
    this.clearAllTimers();
    this.setSnap({ leader: false });
  }

  private onVisibilityChange(): void {
    const visible = this.visibility.isVisible();
    this.hiddenSince = visible ? null : (this.hiddenSince ?? this.wallNow());
    this.sendPresence();
    if (visible) {
      this.clock.detectJump();
      if (this.leader) this.refreshNow();
      else if (!this.hasLiveLeader() && this.isPreferredCandidate()) this.becomeLeader();
    } else if (this.leader) {
      this.syncPollers();
    }
  }

  private allHidden(): boolean {
    if (this.visibility.isVisible()) return false;
    return !this.livePeers().some(([, p]) => p.visible);
  }

  // ------------------------------------------------------------------------------------------------ polling

  private ensureSid(sid: string): SidState {
    let st = this.sids.get(sid);
    if (!st) {
      st = {
        sid,
        events: [],
        seen: new Set(),
        cursor: this.cursors.get(sid),
        lastPage: null,
        viewTimer: null,
        eventsTimer: null,
        viewBackoff: 0,
        eventsBackoff: 0,
        viewInflight: false,
        eventsInflight: false,
      };
      this.sids.set(sid, st);
    }
    return st;
  }

  private watchedSids(): Set<string> {
    const out = new Set<string>(this.localWatch.keys());
    for (const [, p] of this.livePeers()) for (const s of p.watching) out.add(s);
    return out;
  }

  private shouldPoll(sid: string): boolean {
    return this.snap.current?.sessionId === sid || this.watchedSids().has(sid);
  }

  private ctxFor(sid: string): IntervalContext {
    return { nowMs: this.clock.now(), allHidden: this.allHidden(), solo: !this.channel, explicit: this.watchedSids().has(sid) };
  }

  /** 主标签页：为需要的会话安排视图与事件轮询，停止不再需要的。 */
  private syncPollers(): void {
    if (!this.leader) return;
    const want = new Set<string>(this.watchedSids());
    if (this.snap.current) want.add(this.snap.current.sessionId);
    for (const sid of want) {
      const st = this.ensureSid(sid);
      if (!st.viewTimer && !st.viewInflight) {
        if (this.snap.views[sid]) this.scheduleView(st);
        else void this.fetchView(st);
      }
      if (!st.eventsTimer && !st.eventsInflight) {
        if (st.lastPage) this.scheduleEvents(st);
        else void this.fetchEvents(st);
      }
    }
    for (const st of this.sids.values()) {
      if (want.has(st.sid)) continue;
      if (st.viewTimer) clearTimeout(st.viewTimer);
      if (st.eventsTimer) clearTimeout(st.eventsTimer);
      st.viewTimer = st.eventsTimer = null;
    }
    if (!this.snap.current && !this.currentTimer && !this.currentInflight && this.snap.currentLoaded) this.scheduleCurrent(this.allHidden() ? LOW_FREQ_MS : NO_SESSION_POLL_MS);
  }

  private scheduleView(st: SidState, delayOverride?: number): void {
    if (st.viewTimer) clearTimeout(st.viewTimer);
    st.viewTimer = null;
    if (!this.leader || !this.shouldPoll(st.sid)) return;
    const ms = delayOverride ?? viewIntervalMs(this.snap.views[st.sid] ?? null, this.ctxFor(st.sid));
    if (ms === null) return;
    st.viewTimer = setTimeout(() => {
      st.viewTimer = null;
      void this.fetchView(st);
    }, ms);
  }

  private scheduleEvents(st: SidState, delayOverride?: number): void {
    if (st.eventsTimer) clearTimeout(st.eventsTimer);
    st.eventsTimer = null;
    if (!this.leader || !this.shouldPoll(st.sid)) return;
    const ms = delayOverride ?? eventsIntervalMs(this.snap.views[st.sid] ?? null, st.lastPage, this.ctxFor(st.sid));
    if (ms === null) return;
    st.eventsTimer = setTimeout(() => {
      st.eventsTimer = null;
      void this.fetchEvents(st);
    }, ms);
  }

  private scheduleCurrent(ms: number): void {
    if (this.currentTimer) clearTimeout(this.currentTimer);
    this.currentTimer = setTimeout(() => {
      this.currentTimer = null;
      void this.refreshCurrent();
    }, ms);
  }

  private clearAllTimers(): void {
    for (const st of this.sids.values()) {
      if (st.viewTimer) clearTimeout(st.viewTimer);
      if (st.eventsTimer) clearTimeout(st.eventsTimer);
      st.viewTimer = st.eventsTimer = null;
    }
    if (this.currentTimer) clearTimeout(this.currentTimer);
    this.currentTimer = null;
  }

  private async syncTime(): Promise<void> {
    const sentAt = this.wallNow();
    try {
      const r = await this.api.call<{ serverNow: string }>('getTime', { conditional: false });
      this.clock.observe(r.data?.serverNow, sentAt, this.wallNow());
    } catch {
      /* 对时失败不影响轮询；会话视图里的 serverNow 也会对时 */
    }
  }

  private async fetchCurrent(): Promise<void> {
    const sentAt = this.wallNow();
    try {
      const r = await this.api.call<SessionView>('getCurrentSession');
      this.currentBackoff = 0;
      if (!r.notModified) this.clock.observe(r.data?.serverNow, sentAt, this.wallNow());
      this.setCurrent(r.status === 204 ? null : r.data, false);
      this.post({ t: 'current', id: this.tabId, view: this.snap.current });
      this.setSnap({ currentError: null });
      if (!this.snap.current) this.scheduleCurrent(this.allHidden() ? LOW_FREQ_MS : NO_SESSION_POLL_MS);
    } catch (e) {
      if (!isApiError(e)) throw e;
      this.setSnap({ currentError: e, currentLoaded: this.snap.currentLoaded || !e.isTransient });
      this.currentBackoff = nextBackoffMs(this.currentBackoff);
      this.scheduleCurrent(e.isTransient ? this.currentBackoff : NO_SESSION_POLL_MS);
    }
    this.syncPollers();
  }

  private async fetchView(st: SidState): Promise<void> {
    if (st.viewInflight) return;
    st.viewInflight = true;
    const sentAt = this.wallNow();
    try {
      const r = await this.api.call<SessionView>('getSession', { params: { sid: st.sid } });
      st.viewBackoff = 0;
      if (r.data) {
        if (!r.notModified) this.clock.observe(r.data.serverNow, sentAt, this.wallNow());
        if (this.mergeView(r.data) && this.leader) this.post({ t: 'view', id: this.tabId, view: r.data });
      }
    } catch (e) {
      if (!isApiError(e)) throw e;
      if (e.isTransient) {
        st.viewBackoff = nextBackoffMs(st.viewBackoff);
        st.viewInflight = false;
        this.scheduleView(st, st.viewBackoff);
        return;
      }
    } finally {
      st.viewInflight = false;
    }
    this.scheduleView(st);
  }

  private async fetchEvents(st: SidState): Promise<void> {
    if (st.eventsInflight) return;
    st.eventsInflight = true;
    try {
      const r = await this.api.call<EventsPage>('listSessionEvents', { params: { sid: st.sid }, query: { after: st.cursor ?? undefined }, conditional: false });
      st.eventsBackoff = 0;
      const page = r.data ?? { events: [], next: st.cursor };
      st.lastPage = page;
      const fresh = this.acceptEvents(st, page.events ?? []);
      if (page.next) this.setCursor(st, page.next);
      if (fresh.length && this.leader) this.post({ t: 'events', id: this.tabId, sid: st.sid, events: fresh });
    } catch (e) {
      if (!isApiError(e)) throw e;
      st.eventsInflight = false;
      if (e.isTransient) {
        st.eventsBackoff = nextBackoffMs(st.eventsBackoff);
        this.scheduleEvents(st, st.eventsBackoff);
        return;
      }
      // 4xx：游标失效或无权读取 → 丢弃游标，从头重建（P13 #32）；会话视图也补拉一次。已交给界面的事件仍按 id 去重
      this.setCursor(st, null);
      st.lastPage = null;
      void this.fetchView(st);
      st.eventsBackoff = nextBackoffMs(st.eventsBackoff);
      this.scheduleEvents(st, Math.max(st.eventsBackoff, 5_000));
      return;
    } finally {
      st.eventsInflight = false;
    }
    this.scheduleEvents(st);
  }

  private setCursor(st: SidState, cursor: string | null): void {
    st.cursor = cursor;
    this.cursors.set(st.sid, cursor);
  }

  /** 合并事件；返回新增的事件。本标签页的游标推进到收到的最大 id。 */
  private acceptEvents(st: SidState, incoming: readonly SessionEvent[]): SessionEvent[] {
    if (!incoming.length) return [];
    const { events, fresh } = mergeEvents(st.events, st.seen, incoming);
    st.events = events;
    if (!fresh.length) return [];
    const maxId = fresh[fresh.length - 1]!.id;
    if (!st.cursor || maxId > st.cursor) this.setCursor(st, maxId);
    for (const l of this.eventListeners) {
      try {
        l(st.sid, fresh);
      } catch {
        /* 订阅者的异常不影响同步器 */
      }
    }
    if (this.leader) {
      if (fresh.some((e) => isSessionScopedEvent(e.type))) void this.refreshView(st.sid);
      if (fresh.some((e) => e.type === 'session.state_changed')) void this.refreshCurrent();
    }
    return fresh;
  }

  /** 并入会话视图；ver 更小的迟到响应丢弃。返回是否有变化。 */
  private mergeView(view: SessionView): boolean {
    if (!view || typeof view.sessionId !== 'string') return false;
    const prev = this.snap.views[view.sessionId];
    if (prev && typeof prev.ver === 'number' && typeof view.ver === 'number' && view.ver < prev.ver) return false;
    if (prev === view) return false;
    const views = { ...this.snap.views, [view.sessionId]: view };
    const isCurrent = this.snap.current?.sessionId === view.sessionId;
    const wasLive = isCurrent && !isTerminal(this.snap.current!.state);
    this.setSnap({ views, ...(isCurrent ? { current: view } : {}) });
    // 当前会话进入终态：重新发现当前会话（可能已经没有）
    if (isCurrent && wasLive && isTerminal(view.state as SessionState) && this.leader) void this.refreshCurrent();
    return true;
  }

  private setCurrent(view: SessionView | null, fromBroadcast: boolean): void {
    if (view) {
      const prev = this.snap.views[view.sessionId];
      const chosen = prev && prev.ver > view.ver ? prev : view;
      this.setSnap({ current: chosen, currentLoaded: true, views: { ...this.snap.views, [view.sessionId]: chosen } });
    } else {
      this.setSnap({ current: null, currentLoaded: true });
    }
    if (!fromBroadcast) this.syncPollers();
  }

  private setSnap(patch: Partial<SessionSyncSnapshot>): void {
    this.snap = { ...this.snap, ...patch };
    for (const l of this.listeners) l();
  }
}
