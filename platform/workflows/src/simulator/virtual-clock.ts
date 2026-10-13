/**
 * A discrete-event clock for tests and fast dev runs: `sleep()` never waits in real time; whenever the process is
 * otherwise idle (next `setImmediate` turn), time jumps to the earliest pending timer and wakes it. Timers fire in
 * wake-time order, so races such as “task vs. TimeoutSeconds” resolve deterministically.
 * Implements the ClockPort shape of `@atl/shared`.
 */
import type { ClockPort, TimerHandle } from '@atl/shared';

interface PendingTimer {
  at: number;
  seq: number;
  fire: () => void;
  cancel: () => void;
}

export class VirtualClock implements ClockPort {
  private current: number;
  private seq = 0;
  private timers: PendingTimer[] = [];
  private scheduled = false;

  constructor(startMs: number = Date.UTC(2026, 9, 13, 0, 0, 0)) {
    this.current = startMs;
  }

  now(): Date {
    return new Date(this.current);
  }

  nowMs(): number {
    return this.current;
  }

  /** Move time forward by hand (fires every timer that is due, in order). */
  advance(ms: number): void {
    const target = this.current + Math.max(0, ms);
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
      const t = this.timers[0];
      if (!t || t.at > target) break;
      this.timers.shift();
      this.current = Math.max(this.current, t.at);
      t.fire();
    }
    this.current = target;
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      const h = this.add(Math.max(0, ms), () => {
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

  setTimer(ms: number, fn: () => void): TimerHandle {
    return this.add(Math.max(0, ms), fn);
  }

  /** Number of timers still pending. */
  pending(): number {
    return this.timers.length;
  }

  private add(ms: number, fire: () => void): TimerHandle {
    const t: PendingTimer = {
      at: this.current + ms,
      seq: this.seq++,
      fire,
      cancel: () => {
        this.timers = this.timers.filter((x) => x !== t);
      },
    };
    this.timers.push(t);
    this.kick();
    return { cancel: t.cancel };
  }

  private kick(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      if (this.timers.length === 0) return;
      this.timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
      const t = this.timers.shift()!;
      this.current = Math.max(this.current, t.at);
      t.fire();
      if (this.timers.length) this.kick();
    });
  }
}
