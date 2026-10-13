import { describe, expect, it, vi } from 'vitest';
import { json, fakeFetch } from '../test/helpers';
import { ApiClient } from './client';
import { Connectivity } from './connectivity';
import { HEARTBEAT_MS, WorkbenchHeartbeat } from './heartbeat';
import { ServerClock } from './serverClock';
import type { VisibilitySource } from './sessionSync';

describe('ServerClock (02 §5.5)', () => {
  it('offset = serverNow − midpoint of the request; now() applies it', () => {
    let wall = 1_000_000;
    const c = new ServerClock(
      () => wall,
      () => wall,
    );
    c.observe(new Date(1_000_000 + 120_000 + 50).toISOString(), 1_000_000, 1_000_100);
    expect(c.offsetMs).toBe(120_000);
    wall = 2_000_000;
    expect(c.now()).toBe(2_120_000);
    expect(c.skewMinutes).toBeNull();
    c.observe(new Date(2_000_000 + 10 * 60_000).toISOString(), 2_000_000, 2_000_000);
    expect(c.skewMinutes).toBe(10);
  });

  it('keeps the low-latency sample when a slower response arrives', () => {
    const c = new ServerClock(() => 0);
    c.observe(new Date(5_000).toISOString(), 0, 20); // offset 4990, rtt 20
    c.observe(new Date(9_000).toISOString(), 0, 2_000); // rtt 2000 → ignored
    expect(c.offsetMs).toBe(4_990);
  });

  it('detects sleep / clock jumps (wall vs monotonic > 5 s)', () => {
    let wall = 0;
    let mono = 0;
    const c = new ServerClock(
      () => wall,
      () => mono,
    );
    wall += 1000;
    mono += 1000;
    expect(c.detectJump()).toBe(false);
    wall += 60_000;
    mono += 1000;
    expect(c.detectJump()).toBe(true);
  });
});

describe('Connectivity (P13 #1)', () => {
  it('goes offline after 3 consecutive failures and back on success / online event', () => {
    const target = new EventTarget() as unknown as Window;
    const c = new Connectivity(target);
    c.reportFailure(false);
    c.reportFailure(true);
    expect(c.snapshot.offline).toBe(false);
    c.reportFailure(false);
    expect(c.snapshot.offline).toBe(true);
    c.reportSuccess();
    expect(c.snapshot.offline).toBe(false);
    (target as unknown as EventTarget).dispatchEvent(new Event('offline'));
    expect(c.snapshot.offline).toBe(true);
    (target as unknown as EventTarget).dispatchEvent(new Event('online'));
    expect(c.snapshot.offline).toBe(false);
  });
});

describe('WorkbenchHeartbeat (08 §7.2 #9)', () => {
  function vis(initial: boolean) {
    let visible = initial;
    const subs = new Set<() => void>();
    const v: VisibilitySource & { set(x: boolean): void } = {
      isVisible: () => visible,
      subscribe: (cb) => {
        subs.add(cb);
        return () => subs.delete(cb);
      },
      set(x) {
        visible = x;
        for (const s of subs) s();
      },
    };
    return v;
  }

  it('beats immediately with workbench=true, then every 60 s while visible, and again when the tab comes back', async () => {
    vi.useFakeTimers();
    const f = fakeFetch({ 'POST /api/v1/sessions/s1/heartbeat': json(200, { serverNow: new Date().toISOString(), state: 'RUNNING', ver: 4, deadlineAt: null, deadlineVersion: 1 }) });
    const api = new ApiClient({ tokens: { getAccessToken: async () => 't', refresh: async () => false }, fetchImpl: f.impl });
    const applyHeartbeat = vi.fn();
    const v = vis(true);
    const hb = new WorkbenchHeartbeat({ api, sync: { applyHeartbeat }, sid: 's1', visibility: v });
    hb.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.body).toEqual({ workbench: true });
    expect(f.calls[0]!.headers['idempotency-key']).toBeTruthy();
    expect(applyHeartbeat).toHaveBeenCalledWith('s1', expect.objectContaining({ state: 'RUNNING', ver: 4 }), expect.any(Number), expect.any(Number));
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    expect(f.calls).toHaveLength(2);
    v.set(false);
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    expect(f.calls).toHaveLength(2);
    v.set(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.calls).toHaveLength(3);
    hb.stop();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 2);
    expect(f.calls).toHaveLength(3);
  });
});
