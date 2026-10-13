/**
 * P04 准备进度（08 P04“阶段与数据映射”、02 §11.3）：把 `LabSession.phases[]` 与 `session.phase_changed` / `session.progress`
 * 事件映射到 6 个可见阶段。`phase` 的取值还没有在 01 登记（§9.2 #8），这里按名称前缀匹配；未知 `phase` 归入当前阶段的细节行。
 *
 * 不显示进度百分比（02 §11.3）；“已用时间”从 createdAt 起算（serverClock）。
 */
import type { SessionEvent, SessionView } from '../../api/types';

export type PhaseKey = 'validate' | 'base' | 'profile' | 'connect' | 'health' | 'ready';
export type PhaseStatus = 'todo' | 'running' | 'done' | 'retrying' | 'queued' | 'failed' | 'skipped';

export const VISIBLE_PHASES: readonly { key: PhaseKey; title: string; prefixes: readonly string[] }[] = [
  { key: 'validate', title: '校验与预检', prefixes: ['start.'] },
  { key: 'base', title: '创建基础环境', prefixes: ['provision.base', 'provision.resume', 'provision.workstation'] },
  { key: 'profile', title: '部署实验起始状态', prefixes: ['provision.profile', 'provision.extra-stack'] },
  { key: 'connect', title: '连接实验机（SSM）', prefixes: ['provision.ssm', 'provision.wire'] },
  { key: 'health', title: '健康检查', prefixes: ['provision.health'] },
  { key: 'ready', title: '就绪，开始计时', prefixes: ['provision.ready'] },
];

export interface RawPhase {
  name: string;
  status: string;
  /** 最近一次状态变化的时间（lifecycle 的 applyPhaseMarks 只记这一个时间）。 */
  at?: string | null;
  startedAt?: string | null;
  endedAt?: string | null;
  detail?: string | null;
}

export interface PhaseRowModel {
  key: PhaseKey;
  title: string;
  status: PhaseStatus;
  startedAt: number | null;
  endedAt: number | null;
  /** 细节行（起始档位、实例就绪标记、模块 i/n、CloudFormation 资源、重试原因……）。 */
  details: string[];
  /** 慢资源提示（02 §11.1 的“慢”类）。 */
  slowHint: string | null;
}

export function phaseKeyOf(name: string): PhaseKey | null {
  for (const p of VISIBLE_PHASES) if (p.prefixes.some((x) => name.startsWith(x))) return p.key;
  return null;
}

function statusOf(s: string | undefined): PhaseStatus {
  switch ((s ?? '').toUpperCase()) {
    case 'DONE':
      return 'done';
    case 'RUNNING':
      return 'running';
    case 'RETRYING':
      return 'retrying';
    case 'QUEUED':
      return 'queued';
    case 'FAILED':
      return 'failed';
    case 'SKIPPED':
      return 'skipped';
    default:
      return 'todo';
  }
}

const ts = (v: string | null | undefined): number | null => {
  if (!v) return null;
  const n = Date.parse(v);
  return Number.isFinite(n) ? n : null;
};

/** 慢资源（02 §11.1）：RDS、ElastiCache 复制组、CloudFront 分配、EFS、ASG、Image Builder、实例替换。 */
const SLOW: readonly [RegExp, string][] = [
  [/AWS::RDS::/, 'RDS'],
  [/AWS::ElastiCache::ReplicationGroup/, 'ElastiCache 复制组'],
  [/AWS::CloudFront::Distribution/, 'CloudFront 分配'],
  [/AWS::EFS::/, 'EFS'],
  [/AWS::AutoScaling::AutoScalingGroup/, 'Auto Scaling 组'],
  [/AWS::ImageBuilder::/, 'Image Builder'],
];

export function slowResourceName(type: string | null | undefined): string | null {
  if (!type) return null;
  for (const [re, name] of SLOW) if (re.test(type)) return name;
  return null;
}

/** 细节文案（phase 的 detail 是运行器写的英文短语，常见的几种翻成中文；其余原样显示）。 */
export function detailText(phase: string, detail: string | null | undefined): string | null {
  if (!detail) return null;
  if (/^fallback variant (.+)$/.test(detail)) return `已改用回退档 ${detail.replace(/^fallback variant /, '')}`;
  if (/reuse reserved/.test(detail)) return '正在接管保留的环境';
  if (/health gate failed/.test(detail)) return '健康检查未通过，正在修复一次';
  if (/rebooting the lab instance/.test(detail)) return '正在重启实验机后重试';
  if (/queue/i.test(detail) && phase.startsWith('provision')) return '运行器排队中（CodeBuild 并发已满）';
  if (/(another )?availability zone|retry-az/i.test(detail)) return '正在换可用区重试';
  return detail;
}

export interface ProgressDetail {
  module?: string | null;
  moduleIndex?: number;
  moduleTotal?: number;
  resource?: { stack?: string; logicalId?: string; type?: string; status?: string } | null;
  status?: string | null;
}

function progressLine(d: ProgressDetail): string | null {
  const mod = d.module ? (typeof d.moduleIndex === 'number' && typeof d.moduleTotal === 'number' ? `模块 ${d.moduleIndex}/${d.moduleTotal} · ${d.module}` : `模块 ${d.module}`) : null;
  const r = d.resource;
  const res = r && (r.type || r.logicalId) ? `${r.status ? `${r.status} ` : ''}${r.type ?? ''}${r.logicalId ? `（${r.stack ? `${r.stack} · ` : ''}${r.logicalId}）` : ''}`.trim() : null;
  return [mod, res].filter(Boolean).join(' · ') || null;
}

export interface PhaseInput {
  /** 会话视图（`phases[]` 的条目由 lifecycle 写入：name、status、at、detail；api/types 中只声明了 startedAt / endedAt）。 */
  view: Pick<SessionView, 'state' | 'createdAt' | 'readyAt'> & { phases?: readonly RawPhase[] | null; startProfileResolved?: unknown; startProfile?: unknown };
  /** 本会话的最近事件（session.phase_changed / session.progress）。 */
  events: readonly SessionEvent[];
  /** 工作台描述（实验机 / 工作台就绪标记）。 */
  targets?: readonly { tab?: string; ssmPing?: string | null; prepared?: boolean | null; wired?: boolean | null; role?: string }[] | null;
}

/** 6 个可见阶段的当前状态。 */
export function buildPhaseRows(i: PhaseInput): PhaseRowModel[] {
  const rows: PhaseRowModel[] = VISIBLE_PHASES.map((p) => ({ key: p.key, title: p.title, status: 'todo', startedAt: null, endedAt: null, details: [], slowHint: null }));
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const raw = (i.view.phases ?? []) as RawPhase[];
  // 1) 视图里的 phases[]（权威）：按可见阶段汇总——任何子阶段失败 → 失败；有进行中 / 重试 → 该状态；全部完成 → 完成
  const groups = new Map<PhaseKey, RawPhase[]>();
  const unknown: RawPhase[] = [];
  for (const ph of raw) {
    const k = phaseKeyOf(ph.name);
    if (!k) unknown.push(ph);
    else groups.set(k, [...(groups.get(k) ?? []), ph]);
  }
  for (const [k, list] of groups) {
    const r = byKey.get(k)!;
    const sts = list.map((x) => statusOf(x.status)).filter((s) => s !== 'skipped');
    r.status = sts.includes('failed')
      ? 'failed'
      : sts.includes('retrying')
        ? 'retrying'
        : sts.includes('queued')
          ? 'queued'
          : sts.includes('running')
            ? 'running'
            : sts.length && sts.every((s) => s === 'done')
              ? 'done'
              : list.every((x) => statusOf(x.status) === 'skipped')
                ? 'skipped'
                : 'running';
    const starts = list.map((x) => ts(x.startedAt) ?? (statusOf(x.status) !== 'done' ? ts(x.at) : null)).filter((n): n is number => n !== null);
    const ends = list.map((x) => ts(x.endedAt) ?? (statusOf(x.status) === 'done' ? ts(x.at) : null)).filter((n): n is number => n !== null);
    r.startedAt = starts.length ? Math.min(...starts) : null;
    r.endedAt = r.status === 'done' && ends.length ? Math.max(...ends) : null;
    for (const x of list) {
      const d = detailText(x.name, x.detail);
      if (d && !r.details.includes(d)) r.details.push(d);
    }
  }
  // 1b) 事件中的 session.phase_changed 带时间戳：补出开始时间（视图中的阶段完成后只保留完成时间）
  for (const e of i.events) {
    if (e.type !== 'session.phase_changed') continue;
    const d = e.data as { phase?: string; status?: string };
    const k = d.phase ? phaseKeyOf(d.phase) : null;
    const at = ts(e.at);
    if (!k || at === null) continue;
    const r = byKey.get(k)!;
    const st = statusOf(d.status);
    if ((st === 'running' || st === 'queued' || st === 'retrying') && (r.startedAt === null || at < r.startedAt)) r.startedAt = at;
  }
  // 没有开始时间的阶段：按顺序取上一阶段的完成时间（第一阶段取 createdAt）
  let prevEnd = ts(i.view.createdAt);
  for (const r of rows) {
    if (r.status !== 'todo' && r.status !== 'skipped' && r.startedAt === null) r.startedAt = prevEnd;
    if (r.endedAt !== null) prevEnd = r.endedAt;
  }
  // 2) 视图没有 phases[] 时按状态推断（REQUESTED → 第 1 阶段；PROVISIONING → 第 2 阶段；READY 以后全部完成）
  if (!raw.length) {
    if (i.view.state === 'REQUESTED') rows[0]!.status = 'running';
    else if (i.view.state === 'PROVISIONING') {
      rows[0]!.status = 'done';
      rows[1]!.status = 'running';
    }
  }
  if (i.view.readyAt) for (const r of rows) if (r.status !== 'skipped') r.status = 'done';
  // 3) 事件：最近的进度细节行归入当前阶段
  const current = rows.find((r) => ['running', 'retrying', 'queued'].includes(r.status)) ?? null;
  const progress = [...i.events].filter((e) => e.type === 'session.progress').slice(-1)[0];
  if (current && progress) {
    const d = progress.data as ProgressDetail;
    const line = progressLine(d);
    if (line) current.details.push(`正在处理：${line}`);
    const slow = slowResourceName(d.resource?.type ?? null);
    if (slow) current.slowHint = `${slow}通常是最慢的一步。可以先阅读手册第 1～2 节。`;
  }
  if (current) for (const u of unknown) {
    const d = detailText(u.name, u.detail) ?? u.name;
    if (!current.details.includes(d)) current.details.push(d);
  }
  // 4) 起始档位与实例就绪标记
  const profile = typeof i.view.startProfileResolved === 'object' && i.view.startProfileResolved ? (i.view.startProfileResolved as { name?: string }).name : null;
  if (profile && rows[0]!.status !== 'todo') rows[0]!.details.unshift(`起始档位 ${profile}`);
  if (i.targets?.length && rows[1]!.status !== 'todo') {
    const lab = i.targets.find((t) => t.tab === 'terminal-lab' || t.role === 'lab-app');
    const ws = i.targets.find((t) => t.tab === 'terminal-workstation' || t.role === 'workstation');
    const mark = (t: typeof lab) => (t ? (t.ssmPing === 'Online' || t.prepared ? '✓' : '…') : '—');
    rows[1]!.details.push(`实验机 ${mark(lab)} · 工作台 ${ws ? mark(ws) : '—'}`);
  }
  return rows;
}

/** 当前阶段（播报“创建基础环境已完成，用时 4 分 5 秒”时用）。 */
export function completedPhases(rows: readonly PhaseRowModel[]): PhaseKey[] {
  return rows.filter((r) => r.status === 'done').map((r) => r.key);
}

/** 是否“接近部署预算”：已用时间超过等级部署预算的 80%（预算只作内部上限，不显示分钟数）。 */
export function nearBudget(createdAt: string, nowMs: number, budgetMinutes: number | null | undefined): boolean {
  if (!budgetMinutes) return false;
  const start = Date.parse(createdAt);
  return Number.isFinite(start) && nowMs - start > budgetMinutes * 60_000 * 0.8;
}
