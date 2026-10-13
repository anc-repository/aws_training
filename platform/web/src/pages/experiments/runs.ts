/**
 * 对比实验记录的整理（08 P06“变体状态”、“数据来源”；04 §7）：
 * - 卡片声明的变体：`labels` 可以是字符串或 `{ id, role }`；字符串时第一个是 baseline、其余 treatment，只有一个时为 single；
 * - 每个变体的状态：未运行、运行中或未上传（超过 30 分钟提示可能上传失败）、交叉校验中、有效、模拟基线、无效（原因码中文）；
 * - 默认选用每个变体最近一次有效记录（没有有效记录时用最近一次）；
 * - 指标：优先用 `GET /experiment-runs/compare` 的并排结果；否则把各记录的 `summary.client` 与 `server` 的数值叶子展开为行。
 */
import type { LabExperimentDecl } from '../sessions/data';
import type { Better, MetricRow, VariantDecl, VariantRole } from './compareModel';

export interface ExperimentRun {
  runId: string;
  sessionId?: string;
  labId?: string;
  module?: string;
  experiment?: string;
  label?: string;
  variant?: { label?: string; role?: string; cardVariant?: string };
  scenario?: string | null;
  status?: string;
  registeredAt?: string;
  startedAt?: string;
  finishedAt?: string;
  forced?: boolean;
  validity?: { status?: string; reasons?: string[] } | null;
  summary?: { client?: Record<string, unknown> | null } | null;
  server?: Record<string, unknown> | null;
  digest?: string;
}

export type VariantStatus = 'none' | 'running' | 'pending-crosscheck' | 'valid' | 'simulated' | 'invalid';

export function declVariants(decl: Pick<LabExperimentDecl, 'labels'> | null | undefined, runs: readonly ExperimentRun[] = []): VariantDecl[] {
  const raw = decl?.labels ?? [];
  if (raw.length) {
    const objs = raw.map((l) => (typeof l === 'string' ? { id: l } : l));
    return objs.map((l, i) => {
      const role = (l as { role?: string }).role;
      const r: VariantRole = role === 'baseline' || role === 'treatment' || role === 'single' ? role : objs.length === 1 ? 'single' : i === 0 ? 'baseline' : 'treatment';
      const desc = (l as { description?: string; title?: string }).description ?? (l as { title?: string }).title;
      return { label: l.id, role: r, ...(desc ? { description: desc } : {}) };
    });
  }
  // 没有声明（手册不可用）：按记录中的变体
  const seen = new Map<string, VariantRole>();
  for (const r of runs) {
    const label = r.label ?? r.variant?.label;
    if (!label || seen.has(label)) continue;
    const role = r.variant?.role;
    seen.set(label, role === 'baseline' || role === 'treatment' || role === 'single' ? role : 'treatment');
  }
  return [...seen.entries()].map(([label, role]) => ({ label, role }));
}

export function runLabel(r: ExperimentRun): string | null {
  return r.label ?? r.variant?.label ?? null;
}

export function runStatus(r: ExperimentRun | null | undefined): VariantStatus {
  if (!r) return 'none';
  const v = r.validity?.status;
  if (v === 'valid' || v === 'simulated' || v === 'invalid' || v === 'pending-crosscheck') return v;
  if (!r.finishedAt || r.status === 'registered') return 'running';
  return 'pending-crosscheck';
}

/** 登记超过 30 分钟仍未上传。 */
export function maybeUploadFailed(r: ExperimentRun, nowMs: number): boolean {
  return runStatus(r) === 'running' && !!r.registeredAt && nowMs - Date.parse(r.registeredAt) > 30 * 60_000;
}

function newest(a: ExperimentRun, b: ExperimentRun): number {
  const t = (r: ExperimentRun) => r.finishedAt ?? r.registeredAt ?? r.runId;
  return t(b).localeCompare(t(a));
}

/** 每个变体默认选用的记录。 */
export function defaultRun(runs: readonly ExperimentRun[], label: string): ExperimentRun | null {
  const mine = runs.filter((r) => runLabel(r) === label).sort(newest);
  return mine.find((r) => runStatus(r) === 'valid' || runStatus(r) === 'simulated') ?? mine[0] ?? null;
}

export function runsOf(runs: readonly ExperimentRun[], label: string): ExperimentRun[] {
  return runs.filter((r) => runLabel(r) === label).sort(newest);
}

const METRIC_LABELS: Readonly<Record<string, { label: string; unit: string; better: Better }>> = {
  'server.app.requests': { label: '源站收到的请求数', unit: 'count', better: 'lower' },
  'server.origin.requests': { label: '经 Nginx 的源站请求', unit: 'count', better: 'lower' },
  'client.requests': { label: '客户端请求数', unit: 'count', better: 'neutral' },
  'client.errors': { label: '客户端错误数', unit: 'count', better: 'lower' },
  'client.cdnHitRatio': { label: 'CDN 命中率', unit: 'ratio', better: 'higher' },
  'client.hitRatio': { label: '命中率', unit: 'ratio', better: 'higher' },
};

const PCT_LABEL: Readonly<Record<string, string>> = { ttfb: '首字节时间', latency: '延迟', duration: '耗时' };

export function metricMeta(path: string): { label: string; unit: string; better: Better } {
  const hit = METRIC_LABELS[path];
  if (hit) return hit;
  const pct = /(?:^|\.)(ttfb|latency|duration)\.(p\d{2})$/i.exec(path);
  if (pct) return { label: `${PCT_LABEL[pct[1]!.toLowerCase()]} ${pct[2]!.toLowerCase()}（毫秒）`, unit: 'ms', better: 'lower' };
  const leaf = path.split('.').pop() ?? path;
  const unit = /ratio|rate$/i.test(leaf) ? 'ratio' : /(^|[^a-z])(p50|p90|p95|p99|ms|latency|ttfb|duration)/i.test(path) ? 'ms' : 'count';
  const better: Better = /error|lost|fail|latency|ttfb|p50|p95|p99|ms/i.test(path) ? 'lower' : /hit|ratio|success/i.test(path) ? 'higher' : 'neutral';
  return { label: path, unit, better };
}

/** 对象的数值叶子（点路径）。 */
export function numericLeaves(o: unknown, prefix = '', out: Record<string, number> = {}): Record<string, number> {
  if (o && typeof o === 'object' && !Array.isArray(o)) {
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) numericLeaves(v, prefix ? `${prefix}.${k}` : k, out);
  } else if (typeof o === 'number' && Number.isFinite(o)) out[prefix] = o;
  return out;
}

export function runMetrics(r: ExperimentRun | null): Record<string, number> {
  if (!r) return {};
  return numericLeaves({ client: r.summary?.client ?? undefined, server: r.server ?? undefined });
}

export interface CompareResult {
  comparable?: boolean;
  reasons?: string[];
  metrics?: { metric: string; a: number | null; b: number | null; delta?: number | null }[];
}

/** 指标行：以变体标签为列。`compare` 给定时用它（两列），否则按各变体选中的记录展开。 */
export function metricRows(variants: readonly VariantDecl[], chosen: Readonly<Record<string, ExperimentRun | null>>, compare?: { a: string; b: string; result: CompareResult } | null): MetricRow[] {
  const values = new Map<string, Record<string, number | null>>();
  if (compare?.result.metrics?.length) {
    for (const m of compare.result.metrics) values.set(m.metric, { [compare.a]: m.a, [compare.b]: m.b });
  } else {
    for (const v of variants) {
      for (const [k, n] of Object.entries(runMetrics(chosen[v.label] ?? null))) {
        const row = values.get(k) ?? {};
        row[v.label] = n;
        values.set(k, row);
      }
    }
  }
  return [...values.entries()]
    .filter(([k]) => !/\.(startedAt|finishedAt|seed|version)$/i.test(k))
    .map(([k, vals]) => ({ id: k, ...metricMeta(k), values: vals, source: k.startsWith('server.') ? ('server' as const) : ('client' as const) }));
}

/** 客户端与服务端统计差异 > 10%（请求数）。 */
export function clientServerMismatch(r: ExperimentRun | null): { client: number; server: number } | null {
  const m = runMetrics(r);
  const c = m['client.requests'];
  const s = m['server.app.requests'] ?? m['server.origin.requests'];
  if (c === undefined || s === undefined || c === 0) return null;
  return Math.abs(c - s) / c > 0.1 ? { client: c, server: s } : null;
}
