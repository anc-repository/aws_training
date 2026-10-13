// backend/src/adapters/scheduler/eventbridge.ts —— SchedulerPort 的 `eventbridge` 驱动（Amazon EventBridge Scheduler）
// 本轮未实现
// 脚手架桩：方法抛出 NotImplementedError（HTTP 层映射为 501）。由「后续版本（本轮 MVP 不实现；配置该驱动会被 config/implemented.ts 以 CFG-001 拒绝）」填充。
import type { AdapterDeps } from '../types.js';
import type { AdapterMeta, ProbeResult } from '../../ports/common.js';
import type { JobRun, ScheduledJobDef, ScheduledJobName, SchedulerPort } from '../../ports/scheduler.js';
import { notImplemented } from '../../errors.js';

export class EventBridgeScheduler implements SchedulerPort {
  readonly meta: AdapterMeta = { module: 'scheduler', driver: 'eventbridge', awsService: 'Amazon EventBridge Scheduler', authoritative: false };

  constructor(protected readonly deps: AdapterDeps) {}

  async probe(_opts?: { deep?: boolean }): Promise<ProbeResult> {
    throw notImplemented('EventBridgeScheduler', 'probe', 'scheduler');
  }

  register(_defs: ScheduledJobDef[]): void {
    throw notImplemented('EventBridgeScheduler', 'register', 'scheduler');
  }

  async start(_signal: AbortSignal): Promise<void> {
    throw notImplemented('EventBridgeScheduler', 'start', 'scheduler');
  }

  async triggerNow(_name: ScheduledJobName): Promise<JobRun> {
    throw notImplemented('EventBridgeScheduler', 'triggerNow', 'scheduler');
  }

  async listRuns(_limit: number): Promise<JobRun[]> {
    throw notImplemented('EventBridgeScheduler', 'listRuns', 'scheduler');
  }

  async diffRemote(): Promise<Array<{ name: ScheduledJobName; local: string; remote?: string; state?: string }>> {
    throw notImplemented('EventBridgeScheduler', 'diffRemote', 'scheduler');
  }
}
