/**
 * Scaled dev clock (ATL_DEV_TIME_SCALE): platform time runs `scale` times faster than wall time, starting at the real
 * current time. A 2-hour session with scale 60 ends after 2 real minutes. Timers and sleeps are scaled the same way.
 * `skip(ms)` fast-forwards platform time: pending timers keep their platform-time deadlines, so every timer that the
 * jump passes fires right away (schedules, waits, timeouts) and the others are re-armed for the remaining time.
 * `setScale(s)` changes the speed from now on (e2e:platform slows the clock down to watch the reclaim after a skip).
 * Tests use `VirtualClock` from @atl/workflows instead.
 */
import type { ClockPort, TimerHandle } from '@atl/shared';

interface PendingTimer {
  /** platform-time deadline */
  at: number;
  fn: () => void;
  handle: ReturnType<typeof setTimeout>;
}

export class ScaledClock implements ClockPort {
  private realStart = Date.now();
  private virtualStart: number;
  private offsetMs = 0;
  private factor: number;
  private readonly pending = new Set<PendingTimer>();

  constructor(scale: number = 1, startMs: number = Date.now()) {
    if (!(scale > 0)) throw new RangeError('time scale must be > 0');
    this.factor = scale;
    this.virtualStart = startMs;
  }

  /** Platform seconds per wall-clock second. */
  get scale(): number {
    return this.factor;
  }

  /** Change the speed from now on (dev control endpoint); pending timers keep their platform-time deadlines. */
  setScale(scale: number): void {
    if (!(scale > 0)) throw new RangeError('time scale must be > 0');
    const now = this.nowMs();
    this.virtualStart = now;
    this.realStart = Date.now();
    this.offsetMs = 0;
    this.factor = scale;
    for (const t of [...this.pending].sort((a, b) => a.at - b.at)) {
      clearTimeout(t.handle);
      this.arm(t);
    }
  }

  nowMs(): number {
    return Math.floor(this.virtualStart + (Date.now() - this.realStart) * this.factor + this.offsetMs);
  }

  now(): Date {
    return new Date(this.nowMs());
  }

  /** Jump forward (dev control endpoint, smoke:platform). Timers whose platform deadline is passed fire in order. */
  skip(ms: number): void {
    this.offsetMs += Math.max(0, ms);
    const timers = [...this.pending].sort((a, b) => a.at - b.at);
    for (const t of timers) {
      clearTimeout(t.handle);
      this.arm(t);
    }
  }

  /** Number of pending timers (dev state). */
  pendingTimers(): number {
    return this.pending.size;
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      const h = this.setTimer(ms, () => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      });
      const onAbort = () => {
        h.cancel();
        reject(signal!.reason);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  private arm(t: PendingTimer): void {
    const realDelay = Math.max(0, t.at - this.nowMs()) / this.factor;
    t.handle = setTimeout(() => {
      this.pending.delete(t);
      t.fn();
    }, realDelay);
  }

  setTimer(ms: number, fn: () => void): TimerHandle {
    const t: PendingTimer = { at: this.nowMs() + Math.max(0, ms), fn, handle: undefined as unknown as ReturnType<typeof setTimeout> };
    this.pending.add(t);
    this.arm(t);
    return {
      cancel: () => {
        clearTimeout(t.handle);
        this.pending.delete(t);
      },
    };
  }
}
