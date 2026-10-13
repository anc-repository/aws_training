/**
 * In-process EventBridge Scheduler: one-time schedules become timers on the dev clock that invoke `atl-timer` with the
 * payload and then delete themselves (`ActionAfterCompletion: DELETE`). A time in the past fires immediately (real
 * Scheduler behaviour for past `at()` is item V1-11 of 07). `atl-sweeper` runs every 5 platform minutes while enabled.
 */
import {
  SWEEPER_SCHEDULE,
  type ClockPort,
  type InvokerPort,
  type OneTimeScheduleRequest,
  type ScheduleGroup,
  type ScheduleInfo,
  type SchedulerPort,
  type TimerHandle,
  type TimerPayload,
} from '@atl/shared';

interface Entry {
  name: string;
  group: ScheduleGroup;
  at: number;
  payload: TimerPayload;
  timer: TimerHandle;
}

export interface FiredSchedule {
  name: string;
  group: ScheduleGroup;
  at: number;
  firedAt: number;
  payload: TimerPayload;
  error?: string;
}

const SWEEP_INTERVAL_MS = 5 * 60_000;

export class InProcessScheduler implements SchedulerPort {
  private readonly entries = new Map<string, Entry>();
  private sweeper: TimerHandle | null = null;
  readonly fired: FiredSchedule[] = [];

  constructor(
    private readonly clock: ClockPort,
    private readonly invoker: Pick<InvokerPort, 'invoke'>,
  ) {}

  private key(name: string, group: ScheduleGroup): string {
    return `${group}/${name}`;
  }

  async createOneTime(req: OneTimeScheduleRequest): Promise<{ created: boolean }> {
    const k = this.key(req.name, req.group);
    if (this.entries.has(k)) return { created: false };
    const at = req.at.getTime();
    const timer = this.clock.setTimer(Math.max(0, at - this.clock.nowMs()), () => void this.fire(k));
    this.entries.set(k, { name: req.name, group: req.group, at, payload: req.payload, timer });
    return { created: true };
  }

  async delete(name: string, group: ScheduleGroup): Promise<void> {
    const k = this.key(name, group);
    this.entries.get(k)?.timer.cancel();
    this.entries.delete(k);
  }

  async get(name: string, group: ScheduleGroup): Promise<ScheduleInfo | null> {
    if (name === SWEEPER_SCHEDULE && group === 'atl-system') {
      return { name, group, state: this.sweeper ? 'ENABLED' : 'DISABLED', payload: { kind: 'SWEEP' } };
    }
    const e = this.entries.get(this.key(name, group));
    return e ? { name, group, state: 'ENABLED', at: new Date(e.at).toISOString(), payload: e.payload } : null;
  }

  async setSweeperEnabled(enabled: boolean): Promise<void> {
    if (enabled && !this.sweeper) this.armSweeper();
    if (!enabled && this.sweeper) {
      this.sweeper.cancel();
      this.sweeper = null;
    }
  }

  /** Pending one-time schedules (dev control endpoint / tests). */
  list(): { name: string; group: ScheduleGroup; at: string; payload: TimerPayload }[] {
    return [...this.entries.values()].map((e) => ({ name: e.name, group: e.group, at: new Date(e.at).toISOString(), payload: e.payload }));
  }

  private armSweeper(): void {
    this.sweeper = this.clock.setTimer(SWEEP_INTERVAL_MS, () => {
      void this.deliver(SWEEPER_SCHEDULE, 'atl-system', this.clock.nowMs(), { kind: 'SWEEP' }).finally(() => {
        if (this.sweeper) this.armSweeper();
      });
    });
  }

  private async fire(k: string): Promise<void> {
    const e = this.entries.get(k);
    if (!e) return;
    this.entries.delete(k); // ActionAfterCompletion: DELETE
    await this.deliver(e.name, e.group, e.at, e.payload);
  }

  private async deliver(name: string, group: ScheduleGroup, at: number, payload: TimerPayload): Promise<void> {
    const rec: FiredSchedule = { name, group, at, firedAt: this.clock.nowMs(), payload };
    this.fired.push(rec);
    try {
      await this.invoker.invoke('atl-timer', payload);
    } catch (err) {
      rec.error = err instanceof Error ? `${err.name}: ${err.message}` : String(err); // real Scheduler: retries, then atl-timer-dlq
    }
  }
}
