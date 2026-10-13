// /lab 共用的小工具：对比方式文案、实验结果的关键指标差值。
import type { ExperimentResult, LabResultRow, LatencyStats } from '../api/types';

export const COMPARE_LABEL: Record<string, string> = {
  'runtime-ab': '运行时 A/B（X-Compare-Bypass）',
  'before-after': '切换前 / 切换后',
  functional: '功能对照',
  fault: '故障注入',
};

export const CREDENTIALS_LABEL: Record<string, string> = {
  required: '凭证：必需（先启用 iam）',
  optional: '凭证：可选',
  none: '凭证：不需要',
};

/** 结果里第一个有 p95 的服务端路由（没有时退回客户端延迟） */
export function headlineMetric(r: ExperimentResult | undefined): { name: string; stats: LatencyStats } | null {
  if (!r) return null;
  for (const [name, stats] of Object.entries(r.server?.routes ?? {})) if (stats.p95 !== undefined) return { name: `server ${name} p95`, stats };
  for (const [name, stats] of Object.entries(r.client?.latencyMs ?? {})) if (stats.p95 !== undefined) return { name: `client ${name} p95`, stats };
  return null;
}

export interface Delta {
  experiment: string;
  metric: string;
  before: number;
  after: number;
  ratio: number;
}

/** 同一实验最新的 before 与 after（含 l0）之间的关键指标差值 */
export function latestDelta(rows: readonly LabResultRow[]): Delta | null {
  const byExp = new Map<string, { before?: LabResultRow; after?: LabResultRow }>();
  const sorted = [...rows].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  for (const r of sorted) {
    const slot = byExp.get(r.experiment) ?? {};
    const label = r.label.split(':')[0];
    if ((label === 'before' || label === 'l0') && !slot.before) slot.before = r;
    if (label === 'after' && !slot.after) slot.after = r;
    byExp.set(r.experiment, slot);
  }
  for (const [experiment, { before, after }] of byExp) {
    const hb = headlineMetric(before?.result);
    const ha = headlineMetric(after?.result);
    if (!hb || !ha || hb.stats.p95 === undefined || ha.stats.p95 === undefined) continue;
    return { experiment, metric: ha.name, before: hb.stats.p95, after: ha.stats.p95, ratio: hb.stats.p95 ? ha.stats.p95 / hb.stats.p95 : 0 };
  }
  return null;
}

export function deltaText(d: Delta): string {
  const diff = d.after - d.before;
  const arrow = diff > 0 ? '▲' : diff < 0 ? '▼' : '＝';
  return `${d.experiment} · ${d.metric}：${d.before.toFixed(1)} → ${d.after.toFixed(1)} ms ${arrow}${Math.abs(diff).toFixed(1)}（×${d.ratio.toFixed(2)}）`;
}

export function percentile(values: readonly number[], p: number): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[idx]!;
}
