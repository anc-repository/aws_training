// backend/src/ports/common.ts （总纲 §4.2，照录；ModuleId / ModuleStatus / BypassKey 的唯一定义在 @cloudalbum/contracts）
import type { ModuleId, ModuleStatus, BypassKey } from '@cloudalbum/contracts';

export type { ModuleId, ModuleStatus, BypassKey };          // ModuleId 共 40 个（D11）；BypassKey 共 10 个，白名单见 8.3

export interface ProbeResult {
  status: Exclude<ModuleStatus, 'off'>;
  detail: string;                                   // 一行人类可读说明
  latencyMs?: number;
  confidence?: 'confirmed' | 'observed' | 'inferred';
  data?: Record<string, unknown>;                   // 仅管理员可见（ARN、端点、计数）
}

export interface AdapterMeta {
  readonly module: ModuleId;
  readonly driver: string;                          // = 开关变量的取值
  readonly awsService: string | null;               // 本地实现为 null
  readonly authoritative: boolean;                  // 权威数据端口：运行时故障不降级
}

/** 所有适配器的公共契约 */
export interface Adapter {
  readonly meta: AdapterMeta;
  init?(): Promise<void>;                           // 建连、预热；失败记为探针 error，不中断启动
  probe(opts?: { deep?: boolean }): Promise<ProbeResult>;
  close?(): Promise<void>;                          // SIGTERM 时优雅停机
}

/** 有数据的端口实现它，scripts/migrate 用“源驱动 → 目标驱动”的通用搬迁 */
export interface Migratable<TItem> {
  count(): Promise<number>;
  exportBatch(cursor?: string, limit?: number): Promise<{ items: TItem[]; next?: string }>;
  importBatch(items: TItem[]): Promise<{ written: number; skipped: number }>;   // 必须幂等
}

export interface Page<T> { items: T[]; next?: string }
