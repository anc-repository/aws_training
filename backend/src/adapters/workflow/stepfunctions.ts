// backend/src/adapters/workflow/stepfunctions.ts —— WorkflowPort 的 `stepfunctions` 驱动（AWS Step Functions）
// 本轮未实现
// 脚手架桩：方法抛出 NotImplementedError（HTTP 层映射为 501）。由「后续版本（本轮 MVP 不实现；配置该驱动会被 config/implemented.ts 以 CFG-001 拒绝）」填充。
import type { AdapterDeps } from '../types.js';
import type { AdapterMeta, ProbeResult } from '../../ports/common.js';
import type { WorkflowPort } from '../../ports/workflow.js';
import { notImplemented } from '../../errors.js';

export class StepFunctionsWorkflow implements WorkflowPort {
  readonly meta: AdapterMeta = { module: 'workflow', driver: 'stepfunctions', awsService: 'AWS Step Functions', authoritative: true };
  readonly placement = 'stepfunctions' as const;

  constructor(protected readonly deps: AdapterDeps) {}

  async probe(_opts?: { deep?: boolean }): Promise<ProbeResult> {
    throw notImplemented('StepFunctionsWorkflow', 'probe', 'workflow');
  }

  async start(_photo: { photoId: string; rawKey: string; ownerId: string }): Promise<{ executionId: string; mode: 'sync' | 'async' }> {
    throw notImplemented('StepFunctionsWorkflow', 'start', 'workflow');
  }

  async acceptResult(_message: unknown): Promise<void> {
    throw notImplemented('StepFunctionsWorkflow', 'acceptResult', 'workflow');
  }

  async describe(_executionId: string): Promise<{ status: 'running' | 'succeeded' | 'failed'; steps: Array<{ name: string; status: string; attempts: number; durationMs?: number }> }> {
    throw notImplemented('StepFunctionsWorkflow', 'describe', 'workflow');
  }
}
