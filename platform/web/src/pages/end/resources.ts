/**
 * 回收台账的整理（08 P07 资源区块、P07-M；§9.2 #32）：
 * - API 目前按 02 §7.9 的旧写法返回条目（type、id、source、createdBy、hint、lastTriedAt），01 §7.3 写法是 resourceType、name/arn、
 *   discoveredBy、creatorSessionName、manualHint、lastAttemptAt——两种都接受，统一成界面用的 ResourceRowData；
 * - 按 02 §7.5 的删除阶段 S0～S6 分组，给出每组“已删除 / 总数”与默认展开规则（有删除中或需处理的项）；
 * - 待人工处理条目的排序：阻塞且按小时计费 → 阻塞 → 需复核 → 信息；
 * - 慢项提示：CloudFront 分配“正在禁用，部署完成后删除（通常较慢）”、RDS / NAT 异步删除。
 */
import type { CleanupState, ResourceBilling, ResourceSeverity } from '@atl/shared';
import type { ResourceRowData } from '../../ui';
import { discoveredByText, STAGES } from '../sessions/sessionText';

export interface LedgerItem extends ResourceRowData {
  stage: string;
  sessionId: string | null;
  envId: string | null;
  /** 原始的 discoveredBy 枚举（文字放在 discoveredBy 中）。 */
  source: string | null;
  createdBy: string | null;
  security: boolean;
}

const CREATED_BY_ENUM = new Set(['provisioner', 'learner', 'app', 'service']);
const CLEANUP_STATES: readonly string[] = ['TRACKED', 'DELETING', 'DELETED', 'RETAINED', 'REVIEW', 'MANUAL_REQUIRED', 'RESOLVED_BY_LEARNER', 'FAILED'];

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

export function normalizeResource(raw: Record<string, unknown>): LedgerItem {
  const hint = (raw.manualHint ?? raw.hint ?? null) as { consoleUrl?: string | null; cli?: string | null; note?: string | null } | null;
  const source = str(raw.discoveredBy) ?? str(raw.source);
  const createdBy = str(raw.createdBy);
  const creator = str(raw.creatorSessionName) ?? (createdBy && !CREATED_BY_ENUM.has(createdBy) ? createdBy : null);
  const state = str(raw.cleanupState);
  const type = str(raw.resourceType) ?? str(raw.type) ?? '';
  const name = str(raw.name) ?? str(raw.id) ?? str(raw.arn);
  const reason = str(raw.reason) ?? str(raw.lastError);
  return {
    resourceKey: str(raw.resourceKey) ?? `${type}|${name ?? ''}`,
    resourceType: type,
    name,
    arn: str(raw.arn),
    region: str(raw.region),
    cleanupState: (state && CLEANUP_STATES.includes(state) ? state : 'TRACKED') as CleanupState,
    severity: (str(raw.severity) as ResourceSeverity | null) ?? null,
    billing: (str(raw.billing) as ResourceBilling | null) ?? null,
    discoveredBy: discoveredByText(source),
    creatorSessionName: creator,
    attempts: typeof raw.attempts === 'number' ? raw.attempts : null,
    lastAttemptAt: str(raw.lastAttemptAt) ?? str(raw.lastTriedAt),
    reason,
    manualHint: hint ? { consoleUrl: str(hint.consoleUrl), cli: str(hint.cli), note: str(hint.note) } : null,
    stage: str(raw.stage) ?? 'other',
    sessionId: str(raw.sessionId),
    envId: str(raw.envId),
    source,
    createdBy,
    security: raw.security === true || raw.category === 'security' || (/Route53::RecordSet/.test(type) && /\bNS\b/.test(`${name ?? ''} ${reason ?? ''}`)),
  };
}

const DONE: readonly CleanupState[] = ['DELETED', 'RESOLVED_BY_LEARNER'];
const ATTENTION: readonly CleanupState[] = ['MANUAL_REQUIRED', 'REVIEW', 'FAILED'];

export interface StageGroup {
  stage: string;
  items: LedgerItem[];
  done: number;
  total: number;
  busy: boolean;
  bad: boolean;
  /** 首次渲染时的默认展开：有删除中或需处理的项（§7.6 第 5 条：之后由学员决定）。 */
  defaultOpen: boolean;
}

export function groupByStage(items: readonly LedgerItem[]): StageGroup[] {
  const order = [...STAGES, 'other'];
  const groups: StageGroup[] = [];
  for (const stage of order) {
    const list = items.filter((r) => (STAGES as readonly string[]).includes(r.stage) ? r.stage === stage : stage === 'other');
    if (!list.length) continue;
    const done = list.filter((r) => DONE.includes(r.cleanupState)).length;
    const busy = list.some((r) => r.cleanupState === 'DELETING');
    const bad = list.some((r) => ATTENTION.includes(r.cleanupState));
    groups.push({ stage, items: list, done, total: list.length, busy, bad, defaultOpen: busy || bad });
  }
  return groups;
}

export interface LedgerCounts {
  deleted: number;
  deleting: number;
  waiting: number;
  retained: number;
  attention: number;
  total: number;
}

export function countLedger(items: readonly LedgerItem[]): LedgerCounts {
  const n = (states: readonly CleanupState[]) => items.filter((r) => states.includes(r.cleanupState)).length;
  return { deleted: n(DONE), deleting: n(['DELETING']), waiting: n(['TRACKED']), retained: n(['RETAINED']), attention: n(ATTENTION), total: items.length };
}

const SEVERITY_RANK: Record<string, number> = { BLOCKING: 0, REVIEW: 2, INFO: 3 };

/** 待人工处理清单的排序（08 P07“排序”）。 */
export function sortManual(items: readonly LedgerItem[]): LedgerItem[] {
  const rank = (r: LedgerItem) => {
    const sev = SEVERITY_RANK[r.severity ?? 'BLOCKING'] ?? 3;
    return sev === 0 && r.billing === 'hourly' ? -1 : sev;
  };
  return [...items].sort((a, b) => rank(a) - rank(b));
}

/** 仍待处理（未删除、未确认）。 */
export function isOpen(r: Pick<LedgerItem, 'cleanupState'>): boolean {
  return !DONE.includes(r.cleanupState) && r.cleanupState !== 'RETAINED';
}

export function slowHint(r: Pick<LedgerItem, 'resourceType' | 'cleanupState'>): string | null {
  if (DONE.includes(r.cleanupState)) return null;
  if (/CloudFront::Distribution/.test(r.resourceType)) return '正在禁用，部署完成后删除（通常较慢）';
  if (/RDS::DB(Instance|Cluster)/.test(r.resourceType) && r.cleanupState === 'DELETING') return '删除较慢，通常需要数分钟以上';
  if (/NatGateway/.test(r.resourceType) && r.cleanupState === 'DELETING') return '异步删除中';
  if (/ElastiCache/.test(r.resourceType) && r.cleanupState === 'DELETING') return '删除较慢';
  return null;
}
