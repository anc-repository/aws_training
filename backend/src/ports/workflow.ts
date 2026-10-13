// backend/src/ports/workflow.ts   （workflow 模块；驱动 inline | stepfunctions；总纲 §4.2，照录）
import type { Adapter } from './common.js';

export interface WorkflowPort extends Adapter {                    // workflow：inline | stepfunctions（本轮新增）
  readonly placement: 'inline' | 'stepfunctions';
  /** inline：PhotoPipeline 在进程内按顺序编排（缩略图 → 标签与审核 → 通知），写 job_runs；
   *  stepfunctions：执行由 S3→EventBridge 启动，这里只登记“等待结果” */
  start(photo: { photoId: string; rawKey: string; ownerId: string }): Promise<{ executionId: string; mode: 'sync' | 'async' }>;
  /** stepfunctions：worker 从模块自带结果队列取到消息后调用，写回规则同 ImageProcessorPort */
  acceptResult(message: unknown): Promise<void>;
  describe(executionId: string): Promise<{ status: 'running' | 'succeeded' | 'failed';
    steps: Array<{ name: string; status: string; attempts: number; durationMs?: number }> }>;
}
