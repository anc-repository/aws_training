import type { ScheduleGroup, TimerPayload } from '../scheduler.js';

/**
 * EventBridge Scheduler one-time schedules that invoke `atl-timer`. Production: `@aws-sdk/client-scheduler`.
 * Dev: in-process timers on the dev clock.
 */
export interface OneTimeScheduleRequest {
  name: string;
  group: ScheduleGroup;
  /** Aligned to a whole minute (02 §5.2). */
  at: Date;
  payload: TimerPayload;
}

export interface ScheduleInfo {
  name: string;
  group: ScheduleGroup;
  state: 'ENABLED' | 'DISABLED';
  at?: string;
  payload?: TimerPayload;
}

export interface SchedulerPort {
  /**
   * `ActionAfterCompletion: DELETE`, `FlexibleTimeWindow: OFF`, UTC. Returns `created: false` on ConflictException
   * (treated as success, 02 §2.7).
   */
  createOneTime(req: OneTimeScheduleRequest): Promise<{ created: boolean }>;
  /** Deleting a missing schedule is not an error. */
  delete(name: string, group: ScheduleGroup): Promise<void>;
  /** Existence is always decided by name (01 §3.5); `null` when missing. */
  get(name: string, group: ScheduleGroup): Promise<ScheduleInfo | null>;
  /** Enable / disable the periodic `atl-sweeper` (GetSchedule + full UpdateSchedule in production). */
  setSweeperEnabled(enabled: boolean): Promise<void>;
}
