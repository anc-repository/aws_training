/**
 * 对比实验视图（08 P06）的模型：变体列、各变体的记录与状态、指标对照、差异方向、成对可比性。纯函数。
 *
 * - 变体由卡片声明（任意标签，角色 baseline / treatment / single，04 §3.2.10），不假设只有 before / after；
 * - 每个变体默认取“最近一次有效记录”，没有有效记录时取最近一次记录；
 * - 指标只来自实际记录（服务端校正后的值优先，`server.*`；否则客户端统计 `summary.client.*`）；不预设任何结论数值；
 * - 差异小于噪声带（相对 10%，与 `npm run exp:report` 的默认 `--noise 0.1` 一致）时写“差异不明显”；颜色不表示好坏。
 */
import { experimentLabels, type ExperimentDecl, type ExperimentLabel } from './lab';
import type { ExperimentValidity } from '../../ui';

export interface ExperimentRunView {
  runId: string;
  sessionId?: string;
  module: string;
  experiment: string;
  label: string;
  variant?: { label?: string; role?: string; cardVariant?: string };
  scenario?: string | null;
  params?: Record<string, unknown>;
  forced?: boolean;
  status?: 'registered' | 'uploaded' | string;
  registeredAt?: string;
  finishedAt?: string | null;
  uploadedAt?: string | null;
  summary?: { client?: unknown; params?: unknown; targets?: unknown } | null;
  server?: unknown;
  environment?: { instanceType?: string } | null;
  validity?: { status: ExperimentValidity | string; reasons?: string[]; at?: string } | null;
}

export type VariantStatus = 'none' | 'registered' | 'stale-registered' | ExperimentValidity | 'uploaded';

export const REASON_TEXT: Readonly<Record<string, string>> = {
  OUT_OF_WINDOW: '不在登记的时间窗内',
  DRIVER_MISMATCH: '运行时驱动与该变体要求不符',
  NOT_CORROBORATED: '服务端没有看到足够的请求',
  PATH_RATIO: '路径占比不足',
  TOO_FEW_SAMPLES: '样本不足',
  OUTPUT_TRUNCATED: '输出被截断',
  DELIVERY_MISMATCH: '投递位置与要求不符',
  LABEL_NOT_IN_LAB: '变体不在卡片声明中',
};

export function reasonText(code: string): string {
  return REASON_TEXT[code] ?? code;
}

/** 变体状态（P06“变体状态”表）。`nowMs` 用于“登记超过 30 分钟仍未上传”。 */
export function variantStatus(run: ExperimentRunView | null, nowMs: number): VariantStatus {
  if (!run) return 'none';
  const v = run.validity?.status;
  if (v === 'valid' || v === 'simulated' || v === 'invalid' || v === 'pending-crosscheck') return v;
  if (!run.finishedAt && run.status !== 'uploaded') {
    const reg = run.registeredAt ? Date.parse(run.registeredAt) : NaN;
    return Number.isFinite(reg) && nowMs - reg > 30 * 60_000 ? 'stale-registered' : 'registered';
  }
  return 'uploaded';
}

export const VARIANT_STATUS_TEXT: Readonly<Record<VariantStatus, string>> = {
  none: '还没有记录',
  registered: '运行中或未上传',
  'stale-registered': '可能上传失败：请看工作台终端中运行器的输出',
  uploaded: '已上传，等待校验',
  'pending-crosscheck': '交叉校验中（服务端指标可能有数分钟延迟，稍后自动复核）',
  valid: '有效',
  simulated: '模拟基线（旁路补测）',
  invalid: '无效',
};

/** 上传进度的四段（UploadStatusTrack）：已登记 → 已上传 → 交叉校验中 → 有效 / 模拟基线 / 无效；返回当前段的序号。 */
export function trackIndex(s: VariantStatus): number {
  switch (s) {
    case 'none':
      return -1;
    case 'registered':
    case 'stale-registered':
      return 0;
    case 'uploaded':
      return 1;
    case 'pending-crosscheck':
      return 2;
    default:
      return 3;
  }
}

function time(r: ExperimentRunView): string {
  return r.finishedAt ?? r.uploadedAt ?? r.registeredAt ?? r.runId;
}

/** 某变体的记录（新的在前）。 */
export function runsOf(runs: readonly ExperimentRunView[], exp: Pick<ExperimentDecl, 'module' | 'id'>, label: string): ExperimentRunView[] {
  return runs.filter((r) => r.module === exp.module && r.experiment === exp.id && r.label === label).sort((a, b) => time(b).localeCompare(time(a)));
}

/** 默认选择：最近一次有效（或模拟基线）记录；没有时最近一次记录。 */
export function defaultRun(list: readonly ExperimentRunView[]): ExperimentRunView | null {
  return list.find((r) => r.validity?.status === 'valid' || r.validity?.status === 'simulated') ?? list[0] ?? null;
}

export function numericLeaves(o: unknown, prefix = '', out: Record<string, number> = {}): Record<string, number> {
  if (o && typeof o === 'object' && !Array.isArray(o)) {
    for (const [k, v] of Object.entries(o)) numericLeaves(v, prefix ? `${prefix}.${k}` : k, out);
  } else if (typeof o === 'number' && Number.isFinite(o)) out[prefix] = o;
  return out;
}

export interface MetricValues {
  value: number | null;
  client: number | null;
  server: number | null;
  /** 客户端与服务端差异 > 10%。 */
  mismatch: boolean;
}

/** 一次运行的指标：服务端值优先（键去掉 `server.` / `client.` 前缀后对齐）。 */
export function metricsOf(run: ExperimentRunView | null): Record<string, MetricValues> {
  if (!run) return {};
  const client = numericLeaves(run.summary?.client ?? {});
  const server = numericLeaves(run.server ?? {});
  const keys = new Set([...Object.keys(client), ...Object.keys(server)]);
  const out: Record<string, MetricValues> = {};
  for (const k of keys) {
    const c = client[k] ?? null;
    const s = server[k] ?? null;
    const value = s ?? c;
    const mismatch = c !== null && s !== null && Math.max(Math.abs(c), Math.abs(s)) > 0 && Math.abs(c - s) / Math.max(Math.abs(c), Math.abs(s)) > 0.1;
    out[k] = { value, client: c, server: s, mismatch };
  }
  return out;
}

export const NOISE = 0.1;

export interface Delta {
  text: string;
  dir: 'down' | 'up' | 'same' | 'none';
}

/** 差异方向（DeltaCell）：方向只说明变化，不代表好坏。 */
export function deltaOf(a: number | null, b: number | null, label = ''): Delta {
  if (a === null || b === null) return { text: '—', dir: 'none' };
  const d = b - a;
  const base = Math.max(Math.abs(a), Math.abs(b));
  if (base === 0 || Math.abs(d) / base < NOISE) return { text: '差异不明显', dir: 'same' };
  const down = d < 0;
  let text = down ? '▼ 下降' : '▲ 上升';
  if (/ms|毫秒|latency|ttfb/i.test(label)) text += down ? ' · 更快' : ' · 更慢';
  else if (b === 0) text = '▼ 变为 0';
  return { text, dir: down ? 'down' : 'up' };
}

export interface VariantColumn {
  label: ExperimentLabel;
  runs: ExperimentRunView[];
  selected: ExperimentRunView | null;
  status: VariantStatus;
}

export function variantColumns(exp: ExperimentDecl, runs: readonly ExperimentRunView[], selection: Readonly<Record<string, string>>, nowMs: number): VariantColumn[] {
  return experimentLabels(exp).map((label) => {
    const list = runsOf(runs, exp, label.id);
    const sel = list.find((r) => r.runId === selection[label.id]) ?? defaultRun(list);
    return { label, runs: list, selected: sel, status: variantStatus(sel, nowMs) };
  });
}

export interface MetricRow {
  key: string;
  label: string;
  values: (MetricValues | null)[];
  delta: Delta | null;
}

/** 指标行：所有已选记录的指标并集；两列以上时差异取第一对（pairs[0]，默认第 1、2 列）。 */
export function metricRows(exp: ExperimentDecl, cols: readonly VariantColumn[]): MetricRow[] {
  const per = cols.map((c) => metricsOf(c.selected));
  const keys = [...new Set(per.flatMap((m) => Object.keys(m)))].sort();
  const pair = exp.pairs?.[0];
  const ia = pair ? cols.findIndex((c) => c.label.id === pair[0]) : 0;
  const ib = pair ? cols.findIndex((c) => c.label.id === pair[1]) : 1;
  const declared = new Map((exp.metrics ?? []).map((m) => [m.key, m]));
  return keys.map((key) => {
    const values = per.map((m) => m[key] ?? null);
    const a = ia >= 0 ? (values[ia]?.value ?? null) : null;
    const b = ib >= 0 ? (values[ib]?.value ?? null) : null;
    const label = declared.get(key)?.label ?? key;
    return { key, label, values, delta: cols.length > 1 ? deltaOf(a, b, `${label} ${key}`) : null };
  });
}

export interface Comparability {
  comparable: boolean | null;
  reasons: string[];
}

/** 成对可比性（场景、参数、实例类型、起始变体一致；都不是强制运行）。缺少一侧时 comparable = null。 */
export function comparability(a: ExperimentRunView | null, b: ExperimentRunView | null): Comparability {
  if (!a || !b) return { comparable: null, reasons: [] };
  const reasons: string[] = [];
  if ((a.scenario ?? null) !== (b.scenario ?? null)) reasons.push('场景不一致');
  if (JSON.stringify(a.params ?? {}) !== JSON.stringify(b.params ?? {})) reasons.push('参数不一致');
  if ((a.environment?.instanceType ?? null) !== (b.environment?.instanceType ?? null)) reasons.push('实例类型不一致');
  if ((a.variant?.cardVariant ?? null) !== (b.variant?.cardVariant ?? null)) reasons.push('起始变体不一致');
  if (a.forced || b.forced) reasons.push('使用了强制运行');
  return { comparable: reasons.length === 0, reasons };
}

/** 运行命令（P06“怎么运行”）：`npm run exp -- <module> <id> --label <label> --upload`。 */
export function runCommand(exp: Pick<ExperimentDecl, 'module' | 'id'>, label: string): string {
  return `npm run exp -- ${exp.module} ${exp.id} --label ${label} --upload`;
}

/** 手册中 `::experiment` 卡片的一行摘要。 */
export function cardSummary(cols: readonly VariantColumn[]): { label: string; status: VariantStatus; at: string | null }[] {
  return cols.map((c) => ({ label: c.label.id, status: c.status, at: c.selected ? (c.selected.finishedAt ?? c.selected.registeredAt ?? null) : null }));
}
