// backend/src/adapters/workflow/inline.ts —— WorkflowPort 的 `inline` 驱动（本地实现）
// PhotoPipeline 进程内编排（缩略图 → 标签与审核 → 通知），每步写 job_runs
// 脚手架桩：方法抛出 NotImplementedError（HTTP 层映射为 501）。由「L0 本地实现者」填充。
import type { AdapterDeps } from '../types.js';
import type { AdapterMeta, ProbeResult } from '../../ports/common.js';
import type { WorkflowPort } from '../../ports/workflow.js';
import { notImplemented } from '../../errors.js';

export class InlineWorkflow implements WorkflowPort {
  readonly meta: AdapterMeta = { module: 'workflow', driver: 'inline', awsService: null, authoritative: true };
  readonly placement = 'inline' as const;

  constructor(protected readonly deps: AdapterDeps) {}

  async probe(_opts?: { deep?: boolean }): Promise<ProbeResult> {
    throw notImplemented('InlineWorkflow', 'probe', 'workflow');
  }

  async start(_photo: { photoId: string; rawKey: string; ownerId: string }): Promise<{ executionId: string; mode: 'sync' | 'async' }> {
    throw notImplemented('InlineWorkflow', 'start', 'workflow');
  }

  async acceptResult(_message: unknown): Promise<void> {
    throw notImplemented('InlineWorkflow', 'acceptResult', 'workflow');
  }

  async describe(_executionId: string): Promise<{ status: 'running' | 'succeeded' | 'failed'; steps: Array<{ name: string; status: string; attempts: number; durationMs?: number }> }> {
    throw notImplemented('InlineWorkflow', 'describe', 'workflow');
  }
}
