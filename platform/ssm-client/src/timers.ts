/** Injectable timers (tests use fake timers or a manual scheduler). */
export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

type TimerHandle = Parameters<typeof globalThis.clearTimeout>[0];

/** Resolved at call time, so fake timers installed after construction still apply. */
export function defaultTimers(): Timers {
  return {
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (h) => globalThis.clearTimeout(h as TimerHandle),
    setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
    clearInterval: (h) => globalThis.clearInterval(h as TimerHandle),
  };
}
