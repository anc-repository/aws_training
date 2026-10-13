/**
 * P07 结束阶段（08 P07“结束阶段与数据映射”，phase 取值按 §9.2 #8 的建议，lifecycle 已按此写入 `LabSession.phases[]`）：
 * 按名称前缀把 `phases[]` 归到 7 个可见阶段（保留分支多一个“进入节省模式”）；没有记录、但后面的阶段已经开始的，视为已完成
 * （例如 lifecycle 不单独记录 end.workstation-down）；未知名称写入当前阶段的细节行（§9.2 #8 回写前的降级）。
 */
import type { SessionView } from '../../api/types';
import type { ShapeName } from '../../ui';
import type { Tone } from '../../ui/semantics';

export type PhaseStatus = 'QUEUED' | 'RUNNING' | 'RETRYING' | 'DONE' | 'FAILED' | 'SKIPPED';
export type StageStatus = 'todo' | 'queued' | 'running' | 'retrying' | 'done' | 'failed' | 'skipped';

export interface EndStageDef {
  id: 'stop' | 'revoke' | 'finalize' | 'workstation' | 'suspend' | 'destroy' | 'reclaim' | 'conclude';
  title: string;
  phases: readonly string[];
  /** 只在出现记录时显示（保留分支）。 */
  optional?: boolean;
}

export const END_STAGES: readonly EndStageDef[] = [
  { id: 'stop', title: '停止倒计时', phases: ['end.stop-start', 'end.disarm'] },
  { id: 'revoke', title: '收回访问', phases: ['end.revoke'] },
  { id: 'finalize', title: '定稿报告', phases: ['end.finalize', 'end.seal'] },
  { id: 'workstation', title: '删除工作台', phases: ['end.workstation-down'] },
  { id: 'suspend', title: '进入节省模式', phases: ['end.suspend'], optional: true },
  { id: 'destroy', title: '拆除环境栈', phases: ['clean.destroy'] },
  { id: 'reclaim', title: '回收与校验', phases: ['clean.reclaim', 'clean.verify'] },
  { id: 'conclude', title: '结论', phases: ['clean.conclude'] },
];

export const STAGE_STATUS_META: Readonly<Record<StageStatus, { text: string; shape: ShapeName; tone: Tone; spin?: boolean }>> = {
  todo: { text: '未开始', shape: 'ring', tone: 'faint' },
  queued: { text: '排队中', shape: 'hg', tone: 'mut' },
  running: { text: '进行中', shape: 'spin', tone: 'pend', spin: true },
  retrying: { text: '重试中', shape: 'retry', tone: 'pend' },
  done: { text: '完成', shape: 'check', tone: 'pass' },
  failed: { text: '失败', shape: 'xbox', tone: 'fail' },
  skipped: { text: '跳过', shape: 'dash', tone: 'mut' },
};

export interface PhaseRecord {
  name: string;
  status: string;
  at?: string;
  startedAt?: string;
  endedAt?: string;
  detail?: string | null;
}

export interface EndStage {
  def: EndStageDef;
  status: StageStatus;
  /** 最近一条记录的时间。 */
  at: string | null;
  /** 记录中的细节（未知 phase 的名称也归到当前阶段）。 */
  details: string[];
  current: boolean;
}

const RANK: Record<string, number> = { FAILED: 6, RUNNING: 5, RETRYING: 4, QUEUED: 3, DONE: 2, SKIPPED: 1 };

function statusOf(records: PhaseRecord[]): StageStatus {
  if (!records.length) return 'todo';
  // 同一阶段多条记录：取最“活跃”的（失败 > 进行中 > 重试 > 排队 > 完成 > 跳过），但全部完成 / 跳过时为完成
  const latestByName = new Map<string, PhaseRecord>();
  for (const r of records) latestByName.set(r.name, r);
  const sts = [...latestByName.values()].map((r) => r.status);
  if (sts.every((s) => s === 'SKIPPED')) return 'skipped';
  if (sts.every((s) => s === 'DONE' || s === 'SKIPPED')) return 'done';
  const top = sts.sort((a, b) => (RANK[b] ?? 0) - (RANK[a] ?? 0))[0];
  switch (top) {
    case 'FAILED':
      return 'failed';
    case 'RUNNING':
      return 'running';
    case 'RETRYING':
      return 'retrying';
    case 'QUEUED':
      return 'queued';
    default:
      return 'done';
  }
}

/** 结束阶段列表。`settled`：会话已到达结论（终态或 CLEANUP_FAILED）。 */
export function endStages(view: { state: SessionView['state']; phases?: readonly PhaseRecord[] | SessionView['phases'] | null }): EndStage[] {
  const records = ((view.phases ?? []) as PhaseRecord[]).filter((p) => p && typeof p.name === 'string');
  const known = new Set(END_STAGES.flatMap((s) => s.phases));
  const unknown = records.filter((p) => (p.name.startsWith('end.') || p.name.startsWith('clean.')) && !known.has(p.name));
  const settled = ['ENDED', 'FAILED', 'CLEANUP_FAILED'].includes(view.state);
  const stages: EndStage[] = END_STAGES.map((def) => {
    const own = records.filter((p) => def.phases.includes(p.name));
    const last = own[own.length - 1];
    return {
      def,
      status: statusOf(own),
      at: last?.at ?? last?.endedAt ?? last?.startedAt ?? null,
      details: own.map((p) => p.detail).filter((d): d is string => typeof d === 'string' && !!d),
      current: false,
    };
  }).filter((s) => !s.def.optional || (s.status !== 'todo' && s.status !== 'skipped'));
  // 没有记录、但后面的阶段已经开始：视为已完成
  let laterStarted = settled;
  for (let i = stages.length - 1; i >= 0; i--) {
    const s = stages[i]!;
    if (s.status === 'todo' && laterStarted) s.status = 'done';
    if (s.status !== 'todo') laterStarted = true;
  }
  if (settled) {
    const conclude = stages.find((s) => s.def.id === 'conclude');
    if (conclude && conclude.status !== 'failed') conclude.status = view.state === 'CLEANUP_FAILED' ? 'failed' : 'done';
  }
  const cur = stages.find((s) => s.status === 'running' || s.status === 'retrying' || s.status === 'queued' || s.status === 'failed') ?? (settled ? null : stages.find((s) => s.status === 'todo'));
  if (cur) {
    cur.current = true;
    cur.details.push(...unknown.map((p) => p.detail ?? '').filter(Boolean));
  }
  return stages;
}

/** 回收是否在重试（T19）：phases 中出现第二轮 clean.destroy 之前的 RETRYING，或 endReason=CLEANUP_RETRY。 */
export function isRetryingCleanup(view: Pick<SessionView, 'state' | 'endReason'> & { cleanupRetryCount?: number }): number | null {
  if (view.state !== 'CLEANING') return null;
  const k = (view as { cleanupRetryCount?: number }).cleanupRetryCount;
  if (typeof k === 'number' && k > 0) return k + 1;
  return view.endReason === 'CLEANUP_RETRY' ? 2 : null;
}
