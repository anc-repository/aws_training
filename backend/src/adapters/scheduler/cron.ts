// backend/src/adapters/scheduler/cron.ts —— SchedulerPort 的 `cron` 驱动（本地实现）
// node-cron（Asia/Tokyo）+ LockPort 单例；写 job_runs（(name, scheduled_at) 唯一）
// 脚手架桩：方法抛出 NotImplementedError（HTTP 层映射为 501）。由「L0 本地实现者」填充。
import type { AdapterDeps } from '../types.js';
import type { AdapterMeta, ProbeResult } from '../../ports/common.js';
import type { JobRun, ScheduledJobDef, ScheduledJobName, SchedulerPort } from '../../ports/scheduler.js';
import { notImplemented } from '../../errors.js';

export class CronScheduler implements SchedulerPort {
  readonly meta: AdapterMeta = { module: 'scheduler', driver: 'cron', awsService: null, authoritative: false };

  constructor(protected readonly deps: AdapterDeps) {}

  async probe(_opts?: { deep?: boolean }): Promise<ProbeResult> {
    throw notImplemented('CronScheduler', 'probe', 'scheduler');
  }

  register(_defs: ScheduledJobDef[]): void {
    throw notImplemented('CronScheduler', 'register', 'scheduler');
  }

  async start(_signal: AbortSignal): Promise<void> {
    throw notImplemented('CronScheduler', 'start', 'scheduler');
  }

  async triggerNow(_name: ScheduledJobName): Promise<JobRun> {
    throw notImplemented('CronScheduler', 'triggerNow', 'scheduler');
  }

  async listRuns(_limit: number): Promise<JobRun[]> {
    throw notImplemented('CronScheduler', 'listRuns', 'scheduler');
  }
}
