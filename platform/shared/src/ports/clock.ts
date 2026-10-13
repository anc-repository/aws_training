/** Time source. Production: the system clock. Dev: a scaled clock (ATL_DEV_TIME_SCALE) that tests can also advance by hand. */
export interface TimerHandle {
  cancel(): void;
}

export interface ClockPort {
  now(): Date;
  nowMs(): number;
  /** Resolve after `ms` of clock time (scaled in dev). Rejects with the signal's reason when aborted. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  /** Call `fn` after `ms` of clock time. */
  setTimer(ms: number, fn: () => void): TimerHandle;
}
