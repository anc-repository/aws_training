/**
 * Scaled dev clock (ATL_DEV_TIME_SCALE): platform time runs `scale` times faster than wall time, starting at the real
 * current time. A 2-hour session with scale 60 ends after 2 real minutes. Timers and sleeps are scaled the same way.
 * Tests use `VirtualClock` from @atl/workflows instead.
 */
import type { ClockPort, TimerHandle } from '@atl/shared';

export class ScaledClock implements ClockPort {
  private readonly realStart = Date.now();
  private readonly virtualStart: number;
  private offsetMs = 0;

  constructor(
    readonly scale: number = 1,
    startMs: number = Date.now(),
  ) {
    if (!(scale > 0)) throw new RangeError('time scale must be > 0');
    this.virtualStart = startMs;
  }

  nowMs(): number {
    return Math.floor(this.virtualStart + (Date.now() - this.realStart) * this.scale + this.offsetMs);
  }

  now(): Date {
    return new Date(this.nowMs());
  }

  /** Jump forward (dev control endpoint). Pending timers keep their real-time deadlines. */
  skip(ms: number): void {
    this.offsetMs += Math.max(0, ms);
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

  setTimer(ms: number, fn: () => void): TimerHandle {
    const t = setTimeout(fn, Math.max(0, ms) / this.scale);
    return { cancel: () => clearTimeout(t) };
  }
}
