/**
 * 每步检测的呈现模型（08 P05.5；04 §5.3、§8.2、§8.8）：从卡片的检查声明、`GET /sessions/{sid}/steps` 的 StepResult
 * （每个检查的有效结果 `effective`、最近一次自动结果、手动确认与复核）以及最近的 CheckRun 结果，算出 CheckResultRow 的属性。
 *
 * - 判定方式与来源：local / http-header → ◇ 本地，capability → ○ 探针，aws-readonly → □ AWS，experiment → △ 实验，manual → ⬚ 手动；
 * - 手动确认的子类：原生（manual 检查）、降级（aws-readonly 的 error / unavailable）、带证据（manual_evidence）；
 * - 手动确认**不能**覆盖本地、HTTP、能力探针、AWS 只读检查的自动 fail（04 §8.8）；
 * - 等待型检查由浏览器驱动重测：15、30、45、60 秒之后每 60 秒（04 §5.6），页面不可见时停止。
 */
import type { CheckSource } from '@atl/shared';
import type { CheckResult, ManualSub, Trust } from '../../ui';
import { checkLocalId, checkRefRequired, type CheckDecl, type LabDoc, type LabStep } from './lab';

export const SOURCE_OF_TYPE: Readonly<Record<CheckDecl['type'], CheckSource>> = {
  local: 'LOCAL',
  'http-header': 'LOCAL',
  capability: 'PROBE',
  'aws-readonly': 'AWS',
  experiment: 'EXP',
  manual: 'MANUAL',
};

export interface ManualRecord {
  confirmationId: string;
  kind: 'native' | 'degraded';
  result: 'manual' | 'manual_evidence';
  observed?: string;
  note?: string;
  at?: string;
  review?: { decision: 'approve' | 'reject'; comment?: string; at?: string } | null;
}

export interface CheckStateView {
  checkKey?: string;
  required?: boolean;
  effective?: string;
  lastAuto?: { result: string; at: string; runId?: string; errorCode?: string | null } | null;
  lastManual?: ManualRecord | null;
  stale?: boolean;
  ownershipPending?: boolean;
  pendingCrosscheck?: boolean;
  simulated?: boolean;
}

export interface StepResultView {
  stepId: string;
  state: string;
  checks?: Record<string, CheckStateView>;
  firstPassedAt?: string | null;
  lastPassedAt?: string | null;
  startedAt?: string | null;
  driftEvents?: { checkId: string; at: string }[];
  driftAcks?: { at: string; checkIds: string[] }[];
  skipped?: boolean;
  flags?: string[];
}

export interface CheckResultItemView {
  checkKey: string;
  checkId: string;
  stepId: string | null;
  source: CheckSource;
  type?: string;
  result: string;
  required?: boolean;
  trust?: Trust;
  error?: { code: string; message?: string } | null;
  evidence?: Record<string, unknown> | null;
  evidenceKey?: string;
  corroboration?: { id: string; via: string; ok: boolean; required: boolean; observed?: unknown }[];
  ownership?: { basis: string | null; pending: boolean; retryAfterSeconds?: number; detail?: string } | null;
  keyAssertions?: { label: string; expected: unknown; actual: unknown; ok: boolean }[];
  pitfalls?: string[];
  executor?: { kind?: string; function?: string; role?: string };
  at: string;
  pendingCrosscheck?: boolean;
  simulated?: boolean;
}

export interface CheckRunView {
  runId: string;
  stepId: string | null;
  scope?: string;
  status: 'queued' | 'running' | 'done';
  results?: CheckResultItemView[];
  startedAt?: string;
  finishedAt?: string;
  createdAt?: string;
}

export interface CheckRowModel {
  checkId: string;
  title: string;
  decl: CheckDecl | null;
  required: boolean;
  result: CheckResult;
  reason: string | null;
  how: 'auto' | 'manual';
  source: CheckSource;
  sub: ManualSub | null;
  trust: Trust | null;
  summary: string | null;
  at: string | null;
  review: 'pending' | 'approved' | 'rejected' | null;
  reviewComment: string | null;
  stale: boolean;
  /** 允许手动确认（原生 manual；aws-readonly 的 error / unavailable 降级）。 */
  canManual: boolean;
  /** 等待型检查（显示 WaitTimer，由浏览器驱动重测）。 */
  waiting: boolean;
  latest: CheckResultItemView | null;
}

const RESULTS: readonly CheckResult[] = ['not_run', 'queued', 'running', 'pass', 'fail', 'pending', 'error', 'unavailable', 'skipped', 'needs_manual', 'manual', 'manual_evidence'];

function asResult(v: string | null | undefined): CheckResult {
  return v && (RESULTS as readonly string[]).includes(v) ? (v as CheckResult) : 'not_run';
}

function fmtVal(v: unknown): string {
  if (v === undefined) return '—';
  if (typeof v === 'string') return v.length > 60 ? `${v.slice(0, 57)}…` : v;
  try {
    const s = JSON.stringify(v);
    return s.length > 60 ? `${s.slice(0, 57)}…` : s;
  } catch {
    return String(v);
  }
}

/** 期望 / 实际摘要：第一条未通过的关键断言；全部通过时第一条。 */
export function assertionSummary(item: CheckResultItemView | null): string | null {
  const ks = item?.keyAssertions ?? [];
  const bad = ks.find((k) => !k.ok);
  const k = bad ?? ks[0];
  if (!k) return null;
  return bad ? `${k.label} · 期望 ${fmtVal(k.expected)}，实际 ${fmtVal(k.actual)}` : `${k.label}`;
}

/** 本步骤的检查行（按步骤声明的顺序）。`inflight`：已请求、结果未到的检查 id（显示“核验中”）。 */
export function stepCheckRows(lab: LabDoc, step: LabStep, stepResult: StepResultView | null, latestByCheck: ReadonlyMap<string, CheckResultItemView>, inflight: ReadonlySet<string>): CheckRowModel[] {
  return (step.checks ?? []).map((ref) => {
    const id = checkLocalId(ref);
    const decl = lab.checks?.[id] ?? lab.checks?.[typeof ref === 'string' ? ref : ref.ref] ?? null;
    const st = stepResult?.checks?.[id] ?? null;
    const latest = latestByCheck.get(id) ?? null;
    return checkRow(id, decl, checkRefRequired(ref, decl ?? undefined), st, latest, inflight.has(id));
  });
}

export function checkRow(id: string, decl: CheckDecl | null, required: boolean, st: CheckStateView | null, latest: CheckResultItemView | null, running: boolean): CheckRowModel {
  const type = decl?.type ?? 'local';
  const source = latest?.source ?? SOURCE_OF_TYPE[type];
  const lastAutoAt = st?.lastAuto?.at ?? null;
  // 最近的运行结果比 StepResult 新时以运行结果为准（事件到达后、步骤汇总写回前的窗口）
  const newer = latest && (!lastAutoAt || Date.parse(latest.at) >= Date.parse(lastAutoAt)) ? latest : null;
  let result: CheckResult = asResult(st?.effective ?? (newer ? newer.result : null));
  let reason: string | null = newer?.error?.code ?? st?.lastAuto?.errorCode ?? null;
  if (newer && !['manual', 'manual_evidence'].includes(result)) {
    result = asResult(newer.result);
    reason = newer.error?.code ?? null;
  }
  if (running) result = 'running';
  if (result === 'pending' && (st?.ownershipPending || newer?.ownership?.pending)) reason = 'OWNERSHIP_PENDING';
  const manual = st?.lastManual ?? null;
  const isManual = result === 'manual' || result === 'manual_evidence';
  const sub: ManualSub | null = isManual && manual ? (manual.result === 'manual_evidence' ? 'evidence' : manual.kind) : type === 'manual' ? 'native' : null;
  const review = isManual && manual ? (manual.review?.decision === 'approve' ? 'approved' : manual.review?.decision === 'reject' ? 'rejected' : manual.kind === 'degraded' ? 'pending' : null) : null;
  const how: 'auto' | 'manual' = type === 'manual' || isManual ? 'manual' : 'auto';
  let summary: string | null = null;
  if (isManual && manual?.observed) summary = `你填写：${manual.observed}${manual.result === 'manual_evidence' ? ' · 证据已校验' : ''}`;
  else if (reason === 'OWNERSHIP_PENDING') {
    const s = newer?.ownership?.retryAfterSeconds;
    summary = `归属确认中（CloudTrail 通常几分钟，不作保证）${s ? ` · 下次 ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} 后` : ''}`;
  } else if (reason === 'EXPECTED_OUTAGE') summary = '窗口结束后自动重试';
  else if (result === 'error') summary = '不是你的问题';
  else summary = assertionSummary(newer);
  const canManual = !isManual && ((type === 'manual' && result !== 'pass') || (type === 'aws-readonly' && !!decl?.manualFallback && (result === 'error' || result === 'unavailable' || result === 'needs_manual')));
  return {
    checkId: id,
    title: decl?.title ?? id,
    decl,
    required,
    result: result === 'not_run' && type === 'manual' ? 'needs_manual' : result,
    reason,
    how,
    source: isManual ? 'MANUAL' : source,
    sub,
    trust: newer?.trust ?? null,
    summary,
    at: isManual ? (manual?.at ?? lastAutoAt) : (newer?.at ?? lastAutoAt),
    review: review as CheckRowModel['review'],
    reviewComment: manual?.review?.comment ?? null,
    stale: !!st?.stale && result === 'pass',
    canManual,
    waiting: result === 'pending' && !!decl?.wait,
    latest: newer ?? latest,
  };
}

/** 最近一次运行里每个检查的结果（runs 按时间倒序时取第一次出现）。 */
export function latestResults(runs: readonly CheckRunView[]): Map<string, CheckResultItemView> {
  const out = new Map<string, CheckResultItemView>();
  const sorted = [...runs].sort((a, b) => (b.finishedAt ?? b.createdAt ?? b.runId).localeCompare(a.finishedAt ?? a.createdAt ?? a.runId));
  for (const r of sorted) for (const it of r.results ?? []) if (!out.has(it.checkId)) out.set(it.checkId, it);
  return out;
}

/** 等待型检查的重测节奏：15、30、45、60 秒之后每 60 秒（04 §5.6）；n 从 0 开始。 */
export function waitDelayMs(n: number): number {
  return [15_000, 30_000, 45_000, 60_000][n] ?? 60_000;
}

/** 读屏播报：“本步检测完成：3 项通过，1 项未通过”。 */
export function runSummaryText(results: readonly Pick<CheckResultItemView, 'result'>[]): string {
  const pass = results.filter((r) => r.result === 'pass').length;
  const fail = results.filter((r) => r.result === 'fail').length;
  const other = results.length - pass - fail;
  return `本步检测完成：${pass} 项通过${fail ? `，${fail} 项未通过` : ''}${other ? `，${other} 项待定` : ''}`;
}

/** 漂移提示：“这一步曾于 10:42 通过，现在‘…’未通过。” */
export function driftedChecks(rows: readonly CheckRowModel[]): CheckRowModel[] {
  return rows.filter((r) => r.result === 'fail' || r.result === 'error');
}
