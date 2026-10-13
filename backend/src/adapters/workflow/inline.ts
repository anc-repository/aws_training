// backend/src/adapters/workflow/inline.ts —— WorkflowPort 的 `inline` 驱动（本地实现）
//
// PhotoPipeline 在进程内按顺序编排（缩略图 → 标签与审核 → 通知），每步写 job_runs（04#workflow 第 1 节）。
// 编排本身在 services/photo-pipeline.ts 的 runInlinePipeline()；container 装配完全部端口后调用 attachPipeline()
// 注入完整的 PipelineDeps（含 X-Compare-Bypass: image 用的 inline 处理器与 SocialStorePort）。没有注入时（单元测试直接构造）
// 退回 pipelineDepsFromAdapter(deps)。
import type { AdapterDeps } from '../types.js';
import type { AdapterMeta, ProbeResult } from '../../ports/common.js';
import type { WorkflowPort } from '../../ports/workflow.js';
import { HttpError } from '../../errors.js';
import { listSteps } from '../../repositories/job-runs.js';
import { pipelineDepsFromAdapter, runInlinePipeline, type PipelineDeps } from '../../services/photo-pipeline.js';

export class InlineWorkflow implements WorkflowPort {
  readonly meta: AdapterMeta = { module: 'workflow', driver: 'inline', awsService: null, authoritative: true };
  readonly placement = 'inline' as const;
  private pipeline?: PipelineDeps;

  constructor(protected readonly deps: AdapterDeps) {}

  /** container 在全部端口就绪后注入（UNTIMED） */
  attachPipeline(pd: PipelineDeps): void {
    this.pipeline = pd;
  }

  private pd(): PipelineDeps {
    this.pipeline ??= pipelineDepsFromAdapter(this.deps);
    return this.pipeline;
  }

  async probe(_opts?: { deep?: boolean }): Promise<ProbeResult> {
    const wf = this.deps.cfg.workflow;
    const attempts = wf.WORKFLOW_DRIVER === 'inline' ? wf.WORKFLOW_LOCAL_MAX_ATTEMPTS : 3;
    return {
      status: 'ok',
      detail: `PhotoPipeline 在进程内编排（缩略图 → 标签与审核 → 通知）· 每步一行 job_runs · 暂时性错误最多 ${attempts} 次`,
      confidence: 'confirmed',
    };
  }

  async start(photo: { photoId: string; rawKey: string; ownerId: string }): Promise<{ executionId: string; mode: 'sync' | 'async' }> {
    return runInlinePipeline(this.pd(), photo);
  }

  async acceptResult(_message: unknown): Promise<void> {
    // 只有 stepfunctions 档有模块自带的结果队列
    throw new HttpError(404, 'NOT_AVAILABLE', 'WORKFLOW_DRIVER=inline 没有结果队列');
  }

  async describe(executionId: string): Promise<{ status: 'running' | 'succeeded' | 'failed'; steps: Array<{ name: string; status: string; attempts: number; durationMs?: number }> }> {
    // executionId = inline:<photoId>:<随机>；步骤记录按 photoId 查 job_runs（pipeline.*）
    const photoId = executionId.split(':')[1] ?? executionId;
    const db = this.deps.db;
    if (!db) return { status: 'running', steps: [] };
    const rows = await listSteps(db, photoId);
    const steps = rows.map((r) => {
      const started = Date.parse(r.startedAt);
      const finished = r.finishedAt ? Date.parse(r.finishedAt) : NaN;
      return {
        name: r.name.replace(/^pipeline\./, ''),
        status: r.status,
        attempts: r.attempt,
        ...(Number.isFinite(started) && Number.isFinite(finished) ? { durationMs: finished - started } : {}),
      };
    });
    const status = steps.some((s) => s.status === 'failed') ? 'failed'
      : steps.some((s) => s.name === 'notify' && s.status === 'ok') ? 'succeeded' : 'running';
    return { status, steps };
  }
}
