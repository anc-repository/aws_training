// backend/src/ports/scheduler.ts （总纲 §4.2，照录）
import type { Adapter } from './common.js';

/** 共 8 个；scheduler 的 eventbridge 档生成 8 条 Schedule。worker 内循环（告警评估、安全分析、合规自检）不是定时任务 */
export type ScheduledJobName =
  | 'report.daily' | 'share.cleanup' | 'image.reconcile' | 'outbox.retention' | 'lab.compact'
  | 'lab.heartbeat'                  // 无副作用的对照任务，用于双触发时间线实验
  | 'analytics.retention' | 'audit.retention';
export interface ScheduledJobDef {
  name: ScheduledJobName;
  cron: string;                      // 代码中的期望值；eventbridge 档由 CloudFormation 按同一表达式创建 Schedule
  timezone: string;                  // 默认 Asia/Tokyo
  singleton: boolean;                // true：同一时刻全集群只能执行一次（cron 档用 LockPort 保证）
  handler: (run: { scheduledAt: Date; runId: string }) => Promise<void>;
}
export interface JobRun {
  runId: string; name: ScheduledJobName; scheduledAt: string; startedAt: string; finishedAt?: string;
  status: 'running' | 'ok' | 'failed' | 'skipped-locked' | 'skipped-duplicate';
  host: string; trigger: 'cron' | 'eventbridge' | 'manual';
}
export interface SchedulerPort extends Adapter {
  register(defs: ScheduledJobDef[]): void;
  start(signal: AbortSignal): Promise<void>;            // 只在 worker 进程调用
  triggerNow(name: ScheduledJobName): Promise<JobRun>;  // 管理员手动触发
  listRuns(limit: number): Promise<JobRun[]>;           // 两种驱动都写 job_runs 表，/lab 可直接比较
  /** eventbridge 档：比对代码定义与云端 Schedule（只读；修改走 CloudFormation） */
  diffRemote?(): Promise<Array<{ name: ScheduledJobName; local: string; remote?: string; state?: string }>>;
}
// 幂等键 = (name, scheduledAt)：tick 队列至少一次投递，重复的 tick 记为 skipped-duplicate。
