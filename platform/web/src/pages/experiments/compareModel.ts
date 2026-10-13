/**
 * 对比实验的纯计算（08 P06、§5.4 CompareTable / DeltaCell / VariantBarChart / LadderChart、§6.12）：
 * 差值文字、数值格式、条形对照与分位阶梯的几何。SPA（React 渲染）与分享副本（字符串渲染）共用，图表只用类名取色：
 * baseline `.b`（--viz-before 中性灰）、treatment / single `.a`（--viz-after 青瓷）、第三个及以后 `.t3`（--viz-third）。不用红绿。
 * 数值只来自实际记录；差异小于噪声带（10%）时写“差异不明显”；方向只说明变化，不代表好坏。
 */

export type VariantRole = 'baseline' | 'treatment' | 'single';
export type Better = 'lower' | 'higher' | 'neutral';

export interface VariantDecl {
  label: string;
  role: VariantRole;
  /** 变体说明（例如“没有 CloudFront（直连源站）”）。 */
  description?: string;
}

export interface MetricRow {
  id: string;
  label: string;
  unit: string;
  better: Better;
  /** 以变体标签为键；没有记录时缺省或 null。 */
  values: Record<string, number | null | undefined>;
  source?: 'server' | 'client';
}

export const NOISE_BAND = 0.1;

export function isMs(unit: string, label = ''): boolean {
  return unit === 'ms' || /毫秒/.test(label);
}

export function formatMetricValue(v: number | null | undefined, unit: string): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  if (unit === 'ratio') return `${Math.round(v * 1000) / 10}%`;
  if (Number.isInteger(v)) return String(v);
  return String(Math.round(v * 100) / 100);
}

/** DeltaCell：▼/▲ + 文字；颜色不表示好坏（08 §5.4）。 */
export function deltaText(a: number | null | undefined, b: number | null | undefined, unit: string, label = ''): string {
  if (a === null || a === undefined || b === null || b === undefined || !Number.isFinite(a) || !Number.isFinite(b)) return '—';
  const d = b - a;
  const rel = a !== 0 ? Math.abs(d) / Math.abs(a) : d === 0 ? 0 : 1;
  if (rel < NOISE_BAND) return '差异不明显';
  if (b === 0 && a !== 0) return '▼ 变为 0';
  const down = d < 0;
  let t = down ? '▼ 下降' : '▲ 上升';
  if (isMs(unit, label)) t += down ? ' · 更快' : ' · 更慢';
  return t;
}

/** 变体的图表类名：baseline 灰、treatment / single 青瓷、其余依次第三色。 */
export function variantClass(variants: readonly VariantDecl[], label: string): 'b' | 'a' | 't3' {
  const v = variants.find((x) => x.label === label);
  if (v?.role === 'baseline') return 'b';
  const treatments = variants.filter((x) => x.role !== 'baseline');
  const i = treatments.findIndex((x) => x.label === label);
  return i <= 0 ? 'a' : 't3';
}

export interface Bar {
  x: number;
  y: number;
  w: number;
  h: number;
  cls: 'b' | 'a' | 't3';
  label: string;
  valueText: string;
  textX: number;
  textY: number;
}

export interface BarGroup {
  label: string;
  textY: number;
  bars: Bar[];
  gridY1: number;
  gridY2: number;
}

export interface BarsChart {
  width: number;
  height: number;
  labelWidth: number;
  groups: BarGroup[];
  /** `<title>` 与 `<desc>`（读屏）。 */
  title: string;
  desc: string;
}

/** 条形对照：每个指标按变体各一根条（08 P06）。没有任何数值的指标不画。 */
export function buildBarsChart(metrics: readonly MetricRow[], variants: readonly VariantDecl[]): BarsChart | null {
  const labels = variants.map((v) => v.label);
  const rows = metrics.filter((m) => labels.some((l) => Number.isFinite(m.values[l] ?? NaN)));
  if (!rows.length) return null;
  const width = 640;
  const labelWidth = 170;
  const barH = 14;
  const gap = 4;
  const groupGap = 14;
  const groups: BarGroup[] = [];
  let y = 8;
  for (const m of rows) {
    const vals = labels.map((l) => m.values[l]).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    const max = Math.max(1e-9, ...vals.map((v) => Math.abs(v)));
    const scale = (width - labelWidth - 110) / max;
    const bars: Bar[] = [];
    let by = y;
    for (const l of labels) {
      const v = m.values[l];
      if (typeof v !== 'number' || !Number.isFinite(v)) continue;
      const w = Math.max(1, Math.round(Math.abs(v) * scale));
      bars.push({ x: labelWidth, y: by + 4, w, h: barH, cls: variantClass(variants, l), label: l, valueText: `${l} ${formatMetricValue(v, m.unit)}`, textX: labelWidth + w + 6, textY: by + 15 });
      by += barH + gap;
    }
    groups.push({ label: m.label.split('（')[0]!, textY: y + 15, bars, gridY1: y, gridY2: by + 4 });
    y = by + groupGap;
  }
  const desc = rows
    .map((m) => `${m.label}：${labels.map((l) => `${l} ${formatMetricValue(m.values[l], m.unit)}`).join('，')}`)
    .join('；');
  return { width, height: y, labelWidth, groups, title: `条形对照：${labels.join(' 与 ')} 的各项指标`, desc };
}

export interface LadderChart {
  width: number;
  height: number;
  series: { label: string; cls: 'b' | 'a' | 't3'; path: string; points: { x: number; y: number }[]; dashed: boolean }[];
  xTicks: { x: number; text: string }[];
  yTicks: { y: number; text: string }[];
  x0: number;
  x1: number;
  baseY: number;
  title: string;
}

/** 分位阶梯：p50 / p95 / p99 各变体叠放（只有带分位指标时才画）。 */
export function buildLadderChart(metrics: readonly MetricRow[], variants: readonly VariantDecl[]): LadderChart | null {
  const pct = ['p50', 'p95', 'p99']
    .map((p) => ({ p, m: metrics.find((m) => new RegExp(`(^|[._-])${p}($|[._-])`, 'i').test(m.id)) }))
    .filter((x): x is { p: string; m: MetricRow } => !!x.m);
  if (pct.length < 2) return null;
  const labels = variants.map((v) => v.label);
  const all = pct.flatMap(({ m }) => labels.map((l) => m.values[l])).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  if (!all.length) return null;
  const width = 640;
  const height = 170;
  const x0 = 60;
  const x1 = width - 40;
  const max = Math.max(...all) * 1.15 || 1;
  const yOf = (v: number) => Math.round((height - 24 - (v / max) * (height - 44)) * 10) / 10;
  const xOf = (i: number) => Math.round(x0 + (i * (x1 - x0)) / (pct.length - 1));
  const series = labels
    .map((l, si) => {
      const points = pct
        .map(({ m }, i) => ({ v: m.values[l], i }))
        .filter((p): p is { v: number; i: number } => typeof p.v === 'number' && Number.isFinite(p.v))
        .map((p) => ({ x: xOf(p.i), y: yOf(p.v) }));
      return { label: l, cls: variantClass(variants, l), points, path: points.map((p, i) => `${i ? 'L' : 'M'}${p.x} ${p.y}`).join(' '), dashed: si > 0 };
    })
    .filter((s) => s.points.length);
  const top = max / 1.15;
  return {
    width,
    height,
    series,
    x0,
    x1,
    baseY: height - 24,
    xTicks: pct.map(({ p }, i) => ({ x: xOf(i), text: p })),
    yTicks: [0, 0.5, 1].map((f) => ({ y: yOf(top * f), text: String(Math.round(top * f)) })),
    title: `分位阶梯：${pct.map((x) => x.p).join(' / ')}，${labels.join(' 与 ')}`,
  };
}

/** SVG 字符串（分享副本用）；SPA 用 React 渲染同一几何。 */
export function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function barsChartSvg(c: BarsChart, idPrefix: string): string {
  const t = `${idPrefix}-t`;
  const d = `${idPrefix}-d`;
  const parts = [`<svg class="chart" viewBox="0 0 ${c.width} ${c.height}" role="img" aria-labelledby="${t} ${d}"><title id="${t}">${escapeXml(c.title)}</title><desc id="${d}">${escapeXml(c.desc)}</desc>`];
  for (const g of c.groups) {
    parts.push(`<text x="0" y="${g.textY}">${escapeXml(g.label)}</text>`);
    for (const b of g.bars) parts.push(`<rect class="${b.cls}" x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}"/><text x="${b.textX}" y="${b.textY}">${escapeXml(b.valueText)}</text>`);
    parts.push(`<line class="grid" x1="${c.labelWidth}" x2="${c.labelWidth}" y1="${g.gridY1}" y2="${g.gridY2}"/>`);
  }
  parts.push('</svg>');
  return parts.join('');
}

export function ladderChartSvg(c: LadderChart): string {
  const parts = [`<svg class="chart" viewBox="0 0 ${c.width} ${c.height}" role="img" aria-label="${escapeXml(c.title)}">`];
  parts.push(`<line class="grid" x1="${c.x0}" x2="${c.x1}" y1="${c.baseY}" y2="${c.baseY}"/>`);
  for (const y of c.yTicks) parts.push(`<line class="grid" x1="${c.x0}" x2="${c.x1}" y1="${y.y}" y2="${y.y}"/><text x="${c.x0 - 8}" y="${y.y + 4}" text-anchor="end">${escapeXml(y.text)}</text>`);
  for (const s of c.series) {
    parts.push(`<path class="ln ${s.cls}${s.dashed ? ' dash' : ''}" d="${s.path}"/>`);
    for (const p of s.points) parts.push(`<circle class="${s.cls}" cx="${p.x}" cy="${p.y}" r="4"/>`);
  }
  for (const x of c.xTicks) parts.push(`<text x="${x.x}" y="${c.height - 6}" text-anchor="middle">${escapeXml(x.text)}</text>`);
  parts.push('</svg>');
  return parts.join('');
}
