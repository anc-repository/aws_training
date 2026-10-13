import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryBroadcast, type Channel } from '../lib/broadcast';
import { fakeFetch, json, problem, ulid } from '../test/helpers';
import { ApiClient } from './client';
import { ServerClock } from './serverClock';
import {
  eventsIntervalMs,
  LOW_FREQ_MS,
  mergeEvents,
  nextBackoffMs,
  SessionSync,
  viewIntervalMs,
  type CursorStore,
  type VisibilitySource,
} from './sessionSync';
import type { SessionEvent, SessionView } from './types';

const T0 = Date.parse('2026-10-14T06:00:00.000Z');

function view(over: Partial<SessionView> = {}): SessionView {
  return { sessionId: 's1', labId: 'svc-cdn', state: 'RUNNING', ver: 3, createdAt: '2026-10-14T05:00:00.000Z', deadlineAt: new Date(T0 + 3600_000).toISOString(), serverNow: new Date(T0).toISOString(), ...over };
}

function ev(n: number, type = 'check_run.completed', sid = 's1'): SessionEvent {
  return { id: ulid(n), type, at: new Date(T0).toISOString(), data: { sid } };
}

const ctx = { nowMs: T0, allHidden: false, solo: false, explicit: false };

describe('polling cadence (08 §7.3)', () => {
  it.each([
    ['REQUESTED', 5_000],
    ['PROVISIONING', 5_000],
    ['READY', 30_000],
    ['RUNNING', 30_000],
    ['EXPIRING', 10_000],
    ['ENDING', 10_000],
    ['CLEANING', 10_000],
    ['KEPT', 60_000],
    ['CLEANUP_FAILED', 60_000],
    ['ENDED', null],
  ] as const)('%s → %s ms', (state, ms) => {
    expect(viewIntervalMs(view({ state }), ctx)).toBe(ms);
  });

  it('EXPIRING with < 60 s left, or a passed deadline still READY / RUNNING (P13 #18) → 5 s', () => {
    expect(viewIntervalMs(view({ state: 'EXPIRING', deadlineAt: new Date(T0 + 30_000).toISOString() }), ctx)).toBe(5_000);
    expect(viewIntervalMs(view({ state: 'RUNNING', deadlineAt: new Date(T0 - 1).toISOString() }), ctx)).toBe(5_000);
  });

  it('terminal sessions poll only when a screen watches them (rescan window, 60 s); all tabs hidden → 60 s; no BroadcastChannel → doubled', () => {
    expect(viewIntervalMs(view({ state: 'ENDED' }), { ...ctx, explicit: true })).toBe(60_000);
    expect(viewIntervalMs(view({ state: 'PROVISIONING' }), { ...ctx, allHidden: true })).toBe(LOW_FREQ_MS);
    expect(viewIntervalMs(view({ state: 'RUNNING' }), { ...ctx, solo: true })).toBe(60_000);
  });

  it('events use the server pollAfterMs, page immediately while hasMore, 60 s for KEPT / CLEANUP_FAILED', () => {
    expect(eventsIntervalMs(view(), { pollAfterMs: 15_000 }, ctx)).toBe(15_000);
    expect(eventsIntervalMs(view(), { hasMore: true, pollAfterMs: 1_000 }, ctx)).toBe(0);
    expect(eventsIntervalMs(view({ state: 'KEPT' }), { pollAfterMs: 10_000 }, ctx)).toBe(60_000);
    expect(eventsIntervalMs(view({ state: 'ENDED' }), { pollAfterMs: 60_000 }, ctx)).toBeNull();
    expect(eventsIntervalMs(view(), { pollAfterMs: 15_000 }, { ...ctx, allHidden: true })).toBe(LOW_FREQ_MS);
  });

  it('backoff 1, 2, 4 … 60 s', () => {
    const seq: number[] = [];
    let b = 0;
    for (let i = 0; i < 8; i++) seq.push((b = nextBackoffMs(b)));
    expect(seq).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]);
  });
});

describe('mergeEvents (08 §7.2 #4)', () => {
  it('dedupes by id, sorts by id and keeps the last N', () => {
    const seen = new Set<string>();
    const a = mergeEvents([], seen, [ev(3), ev(1), ev(2)]);
    expect(a.events.map((e) => e.id)).toEqual([ulid(1), ulid(2), ulid(3)]);
    const b = mergeEvents(a.events, seen, [ev(2), ev(4)], 3);
    expect(b.fresh.map((e) => e.id)).toEqual([ulid(4)]);
    expect(b.events.map((e) => e.id)).toEqual([ulid(2), ulid(3), ulid(4)]);
  });
});

// ---------------------------------------------------------------------------------------------------------------

interface Backend {
  current: string | null;
  views: Map<string, SessionView>;
  events: Map<string, SessionEvent[]>;
  eventsError?: number;
  viewError?: number;
  pageSize: number;
}

function backend(b: Backend) {
  return fakeFetch({
    'GET /api/v1/time': () => json(200, { serverNow: new Date(Date.now()).toISOString() }),
    'GET /api/v1/sessions/current': () => (b.current ? json(200, b.views.get(b.current)) : new Response(null, { status: 204 })),
    'GET /api/v1/sessions/*': (c) => {
      const url = new URL(c.url, 'http://x');
      const parts = url.pathname.split('/').filter(Boolean); // api v1 sessions sid [events]
      const sid = parts[3]!;
      if (parts[4] === 'events') {
        if (b.eventsError) return problem(b.eventsError, 'VALIDATION_FAILED');
        const after = url.searchParams.get('after');
        const all = (b.events.get(sid) ?? []).filter((e) => !after || e.id > after);
        const page = all.slice(0, b.pageSize);
        return json(200, { events: page, next: page.length ? page[page.length - 1]!.id : after, hasMore: all.length > page.length, pollAfterMs: 15_000 });
      }
      if (b.viewError) return problem(b.viewError, 'UPSTREAM_UNAVAILABLE');
      const v = b.views.get(sid);
      return v ? json(200, v) : problem(404, 'NOT_FOUND');
    },
  });
}

function memCursors(): CursorStore & { data: Map<string, string | null> } {
  const data = new Map<string, string | null>();
  return { data, get: (sid) => data.get(sid) ?? null, set: (sid, c) => void data.set(sid, c) };
}

function visibility(initial = true) {
  let visible = initial;
  const subs = new Set<() => void>();
  return {
    isVisible: () => visible,
    subscribe: (cb: () => void) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    set(x: boolean) {
      visible = x;
      for (const s of subs) s();
    },
  } satisfies VisibilitySource & { set(x: boolean): void };
}

function makeSync(b: Backend, opts: { channel?: Channel | null; cursors?: CursorStore; tabId?: string; vis?: VisibilitySource } = {}) {
  const f = backend(b);
  const api = new ApiClient({ tokens: { getAccessToken: async () => 'dev.learner.u1', refresh: async () => false }, fetchImpl: f.impl });
  const sync = new SessionSync({ api, clock: new ServerClock(), channel: opts.channel ?? null, cursors: opts.cursors ?? memCursors(), visibility: opts.vis ?? visibility(), tabId: opts.tabId });
  return { sync, f };
}

const count = (f: ReturnType<typeof fakeFetch>, re: RegExp) => f.calls.filter((c) => re.test(c.url)).length;

// 没有 BroadcastChannel 时间隔加倍（P13 #30）：RUNNING 的视图 60 秒、事件 30 秒
describe('SessionSync (single tab, no BroadcastChannel)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => vi.useRealTimers());

  it('discovers the current session, consumes events page by page from the beginning and stores the cursor', async () => {
    const b: Backend = { current: 's1', views: new Map([['s1', view()]]), events: new Map([['s1', [ev(1), ev(2), ev(3)]]]), pageSize: 2 };
    const cursors = memCursors();
    const { sync, f } = makeSync(b, { cursors });
    const got: string[] = [];
    sync.onEvents((_sid, events) => got.push(...events.map((e) => e.id)));
    sync.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(sync.isLeader).toBe(true);
    expect(sync.getSnapshot().current?.sessionId).toBe('s1');
    expect(sync.getSnapshot().currentLoaded).toBe(true);
    expect(got).toEqual([ulid(1), ulid(2), ulid(3)]);
    expect(cursors.data.get('s1')).toBe(ulid(3));
    // 第一次不带 after，第二页带
    const evCalls = f.calls.filter((c) => c.url.includes('/events'));
    expect(evCalls[0]!.url).not.toContain('after=');
    expect(evCalls[1]!.url).toContain(`after=${ulid(2)}`);
    expect(sync.recentEvents('s1')).toHaveLength(3);
    sync.stop();
  });

  it('a session.* event triggers an immediate view refresh; state_changed also re-discovers the current session', async () => {
    const b: Backend = { current: 's1', views: new Map([['s1', view()]]), events: new Map([['s1', []]]), pageSize: 50 };
    const { sync, f } = makeSync(b);
    sync.start();
    await vi.advanceTimersByTimeAsync(10);
    const views0 = count(f, /\/sessions\/s1$/);
    const current0 = count(f, /\/sessions\/current/);
    b.views.set('s1', view({ state: 'ENDING', ver: 4 }));
    b.events.set('s1', [ev(10, 'session.state_changed')]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(count(f, /\/sessions\/s1$/)).toBeGreaterThan(views0);
    expect(count(f, /\/sessions\/current/)).toBeGreaterThan(current0);
    expect(sync.getSnapshot().current?.state).toBe('ENDING');
    sync.stop();
  });

  it('drops late responses with a lower ver (§7.2 #4)', async () => {
    const b: Backend = { current: 's1', views: new Map([['s1', view({ ver: 5 })]]), events: new Map(), pageSize: 50 };
    const { sync } = makeSync(b);
    sync.start();
    await vi.advanceTimersByTimeAsync(10);
    sync.applyView(view({ ver: 4, state: 'READY' }));
    expect(sync.getSnapshot().views.s1!.ver).toBe(5);
    sync.applyView(view({ ver: 6, state: 'EXPIRING' }));
    expect(sync.getSnapshot().current?.state).toBe('EXPIRING');
    sync.stop();
  });

  it('continues from the stored cursor after a reload; a 4xx on events drops the cursor and rebuilds (P13 #32)', async () => {
    const cursors = memCursors();
    cursors.set('s1', ulid(2));
    const b: Backend = { current: 's1', views: new Map([['s1', view()]]), events: new Map([['s1', [ev(1), ev(2), ev(3)]]]), pageSize: 50 };
    const { sync, f } = makeSync(b, { cursors });
    const got: string[] = [];
    sync.onEvents((_s, e) => got.push(...e.map((x) => x.id)));
    sync.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(f.calls.find((c) => c.url.includes('/events'))!.url).toContain(`after=${ulid(2)}`);
    expect(got).toEqual([ulid(3)]);
    b.eventsError = 400;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(cursors.data.get('s1')).toBeNull();
    b.eventsError = undefined;
    await vi.advanceTimersByTimeAsync(5_000);
    const last = f.calls.filter((c) => c.url.includes('/events')).pop()!;
    expect(last.url).not.toContain('after=');
    expect(got).toEqual([ulid(3), ulid(1), ulid(2)]);
    sync.stop();
  });

  it('without a current session it re-checks every 60 s; watch() polls an explicit session', async () => {
    const b: Backend = { current: null, views: new Map([['s9', view({ sessionId: 's9', state: 'ENDED' })]]), events: new Map(), pageSize: 50 };
    const { sync, f } = makeSync(b);
    sync.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(sync.getSnapshot().current).toBeNull();
    expect(count(f, /\/sessions\/current/)).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(count(f, /\/sessions\/current/)).toBe(2);
    const unwatch = sync.watch('s9');
    await vi.advanceTimersByTimeAsync(10);
    expect(sync.getSnapshot().views.s9?.state).toBe('ENDED');
    unwatch();
    const n = count(f, /\/sessions\/s9$/);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(count(f, /\/sessions\/s9$/)).toBe(n);
    sync.stop();
  });

  it('backs off on network errors / 5xx', async () => {
    const b: Backend = { current: 's1', views: new Map([['s1', view()]]), events: new Map(), pageSize: 50 };
    const { sync, f } = makeSync(b);
    sync.start();
    await vi.advanceTimersByTimeAsync(10);
    b.viewError = 503;
    await vi.advanceTimersByTimeAsync(60_000); // 正常节奏的第一次失败
    const n0 = count(f, /\/sessions\/s1$/);
    await vi.advanceTimersByTimeAsync(1_000);
    const n1 = count(f, /\/sessions\/s1$/);
    await vi.advanceTimersByTimeAsync(2_000);
    const n2 = count(f, /\/sessions\/s1$/);
    expect([n1 - n0, n2 - n1]).toEqual([1, 1]);
    sync.stop();
  });
});

describe('SessionSync leader election (BroadcastChannel)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => vi.useRealTimers());

  it('first come first served: one leader polls, the follower receives views over the channel; on bye the follower takes over', async () => {
    const factory = createMemoryBroadcast();
    const b: Backend = { current: 's1', views: new Map([['s1', view()]]), events: new Map([['s1', [ev(1)]]]), pageSize: 50 };
    const A = makeSync(b, { channel: factory('atl-session'), tabId: 'a' });
    const B = makeSync(b, { channel: factory('atl-session'), tabId: 'b' });
    A.sync.start();
    await vi.advanceTimersByTimeAsync(1_300);
    expect(A.sync.isLeader).toBe(true);
    B.sync.start();
    await vi.advanceTimersByTimeAsync(1_300);
    expect(B.sync.isLeader).toBe(false);
    expect(B.f.calls).toHaveLength(0);
    expect(B.sync.getSnapshot().current?.sessionId).toBe('s1');
    // 主标签页拉到的事件广播给其他标签页
    const got: string[] = [];
    B.sync.onEvents((_s, e) => got.push(...e.map((x) => x.id)));
    b.events.set('s1', [ev(1), ev(2)]);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(got).toContain(ulid(2));
    // 主标签页关闭
    A.sync.dispose();
    await vi.advanceTimersByTimeAsync(10);
    expect(B.sync.isLeader).toBe(true);
    await vi.advanceTimersByTimeAsync(10);
    expect(B.f.calls.length).toBeGreaterThan(0);
    B.sync.dispose();
  });

  it('a hidden leader hands over to a visible tab after 15 s', async () => {
    const factory = createMemoryBroadcast();
    const b: Backend = { current: 's1', views: new Map([['s1', view()]]), events: new Map(), pageSize: 50 };
    const visA = visibility(true);
    const A = makeSync(b, { channel: factory('atl-session'), tabId: 'a', vis: visA });
    const B = makeSync(b, { channel: factory('atl-session'), tabId: 'b' });
    A.sync.start();
    await vi.advanceTimersByTimeAsync(1_300);
    B.sync.start();
    await vi.advanceTimersByTimeAsync(1_300);
    visA.set(false);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(A.sync.isLeader).toBe(false);
    expect(B.sync.isLeader).toBe(true);
    A.sync.dispose();
    B.sync.dispose();
  });
});
