/**
 * experiments/_lib/report.ts —— 对比报告（总纲 §8.2“报告生成”）
 *
 *   npm run exp:report -- <module> [--experiment <id>] [--before latest|<文件>] [--after latest|<文件>]
 *                         [--pair before,after | --pair after:A,after:B] [--format md,json,html] [--noise 0.1]
 *                         [--results <目录>] [--out <目录>]
 *
 * - 默认各取同一实验、对应标签的最新一次结果；结果内有 --repeat 多轮时取中位数并给出最小～最大区间。
 * - `--pair <label>:A,<label>:B`：同一次 --ab 运行内的两个变体（A = 带旁路头 = “没有”，B = 不带 = “有”）。
 * - 先检查可比性（同一实验、参数、目标、实例类型），再输出：环境差异（哪些驱动变了）、关键指标对照（绝对值、差值、比值）、
 *   延迟分布（Markdown 表格；HTML 内联 SVG）、按 expect 逐条判定“符合 / 不符合 / 差异小于噪声带无法判断”。只做方向性判断。
 * - 输出到 `_reports/<module>/<UTC时间>__<实验>.{md,json,html}`。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { canonicalMetric, defaultMetricKeys, findRoute, isLatencyMetric, normRoute, resolveMetric, type MetricValue } from './metrics.js';
import { loadManifest } from './manifest.js';
import type { ExpectDirection, ExpectSpec, LatencyStats, ResultDoc, ServerRouteStats } from './types.js';
import { experimentsRoot, fileTimestamp, isRecord } from './util.js';

export type Verdict = 'pass' | 'fail' | 'inconclusive' | 'missing';

export const VERDICT_TEXT: Record<Verdict, string> = {
  pass: '符合',
  fail: '不符合',
  inconclusive: '差异小于噪声带，无法判断',
  missing: '缺少数据',
};

export interface ReportSide {
  /** 标签（`before`、`after:A`） */
  label: string;
  file: string;
  doc: ResultDoc;
}

export interface MetricRow {
  key: string;
  before: MetricValue;
  after: MetricValue;
  diff?: number;
  ratio?: number;
}

export interface ExpectRow {
  metric: string;
  direction: ExpectDirection;
  note?: string;
  before?: number;
  after?: number;
  band?: number;
  verdict: Verdict;
  verdictText: string;
}

export interface ReportData {
  schemaVersion: 1;
  module: string;
  experiment: string;
  title: string;
  generatedAt: string;
  pair: [string, string];
  sources: Record<'before' | 'after', { file: string; runId: string; label: string; forced: boolean; startedAt: string; target: string }>;
  comparable: boolean;
  warnings: string[];
  noise: number;
  environmentDiff: Array<{ module: string; before?: string; after?: string; statusBefore?: string; statusAfter?: string }>;
  metrics: MetricRow[];
  expectations: ExpectRow[];
  routes: Array<{ route: string; before?: LatencyStats; after?: LatencyStats }>;
  paths: Record<'before' | 'after', Array<{ signature: string; count: number }>>;
}

// ------------------------------------------------------------------------------------- 结果文件

export interface LoadedResult {
  file: string;
  doc: ResultDoc;
}

export function loadResults(dir: string): LoadedResult[] {
  if (!existsSync(dir)) return [];
  const out: LoadedResult[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(dir, name);
    try {
      const doc = JSON.parse(readFileSync(file, 'utf8')) as ResultDoc;
      if (isRecord(doc) && doc.schemaVersion === 1 && typeof doc.runId === 'string') out.push({ file, doc });
    } catch {
      /* 忽略损坏的文件 */
    }
  }
  return out.sort((a, b) => a.doc.startedAt.localeCompare(b.doc.startedAt) || a.file.localeCompare(b.file));
}

/** A/B 变体视图：client 换成 byVariant[<label>:<v>]；服务端路由取路径签名中带 / 不带 `bypass=` 的最大分组（近似）。 */
export function variantView(doc: ResultDoc, variant: 'A' | 'B'): ResultDoc {
  const key = `${doc.label}:${variant}`;
  const slice = doc.client.byVariant?.[key];
  if (!slice) throw new Error(`${doc.runId} 没有变体 ${key}（不是 --ab 运行？）`);
  const routes: Record<string, ServerRouteStats> = {};
  for (const [k, s] of Object.entries(doc.server.paths ?? {})) {
    const bypassed = /(?:^|[;|]\s*)bypass=/.test(k);
    if ((variant === 'A') !== bypassed) continue;
    const route = k.split('|')[0]!.trim();
    if (!routes[route] || routes[route]!.count < s.count) routes[route] = s;
  }
  const { repeats: _repeats, ...rest } = doc;
  return {
    ...rest,
    variant: key,
    client: { ...slice },
    server: { ...doc.server, routes: Object.keys(routes).length ? routes : doc.server.routes },
  };
}

function pickSide(all: LoadedResult[], experiment: string, label: string, spec: string | undefined, resultsDir: string): ReportSide {
  const [base, variant] = label.split(':') as [string, ('A' | 'B') | undefined];
  let chosen: LoadedResult | undefined;
  if (spec && spec !== 'latest') {
    const candidates = [spec, path.join(resultsDir, spec)];
    const file = candidates.find((f) => existsSync(f));
    if (!file) throw new Error(`找不到结果文件：${spec}`);
    chosen = { file, doc: JSON.parse(readFileSync(file, 'utf8')) as ResultDoc };
  } else {
    const matching = all.filter((r) => r.doc.experiment === experiment && r.doc.label === base);
    chosen = matching[matching.length - 1];
    if (!chosen) throw new Error(`没有实验 ${experiment} 标签 ${base} 的结果（先运行 npm run exp -- <module> --scenario ${experiment} --label ${base}）`);
  }
  const doc = variant ? variantView(chosen.doc, variant) : chosen.doc;
  return { label, file: chosen.file, doc };
}

// ------------------------------------------------------------------------------------- 计算

function fmtNum(v: number | undefined): string {
  if (v === undefined || !Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  if (abs >= 1e9) return `${(v / 1e9).toFixed(2)}G`;
  if (abs >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (abs >= 1e4) return `${(v / 1e3).toFixed(1)}k`;
  if (Number.isInteger(v)) return String(v);
  return abs < 1 ? v.toFixed(3) : v.toFixed(1);
}

function fmtValue(m: MetricValue): string {
  if (m.value === undefined) return '—';
  return m.n && m.n > 1 && m.min !== undefined && m.max !== undefined ? `${fmtNum(m.value)}（${fmtNum(m.min)}～${fmtNum(m.max)}）` : fmtNum(m.value);
}

export function noiseBand(before: MetricValue, after: MetricValue, noise: number, absFloor = 0): number {
  const rel = noise * Math.max(Math.abs(before.value ?? 0), Math.abs(after.value ?? 0));
  const halfRange = (m: MetricValue) => (m.min !== undefined && m.max !== undefined ? (m.max - m.min) / 2 : 0);
  return Math.max(rel, halfRange(before), halfRange(after), absFloor);
}

/**
 * 判定方向。噪声带 = max(noise × 两者较大值, 多轮区间的一半, absFloor)；毫秒类指标 absFloor = 1（见 isLatencyMetric）。
 */
export function judge(direction: ExpectDirection, before: MetricValue, after: MetricValue, noise: number, absFloor = 0): { verdict: Verdict; band?: number } {
  const a = after.value;
  if (direction === 'zero') return a === undefined ? { verdict: 'missing' } : { verdict: a === 0 ? 'pass' : 'fail' };
  if (direction === 'nonzero') return a === undefined ? { verdict: 'missing' } : { verdict: a !== 0 ? 'pass' : 'fail' };
  const b = before.value;
  if (a === undefined || b === undefined) return { verdict: 'missing' };
  const band = noiseBand(before, after, noise, absFloor);
  const d = a - b;
  const within = Math.abs(d) <= band;
  switch (direction) {
    case 'down': return { verdict: within ? 'inconclusive' : d < 0 ? 'pass' : 'fail', band };
    case 'up': return { verdict: within ? 'inconclusive' : d > 0 ? 'pass' : 'fail', band };
    case 'flat': return { verdict: within ? 'pass' : 'fail', band };
    case 'up-or-flat': return { verdict: d >= -band ? 'pass' : 'fail', band };
    case 'down-or-flat': return { verdict: d <= band ? 'pass' : 'fail', band };
    default: return { verdict: 'missing' };
  }
}

function comparability(b: ResultDoc, a: ResultDoc, sameRun: boolean): string[] {
  const w: string[] = [];
  if (b.experiment !== a.experiment) w.push(`实验不同：${b.experiment} vs ${a.experiment}`);
  if (sameRun) return w;
  const pb = { vus: b.params.vus, duration: b.params.duration, repeat: b.params.repeat, ab: b.params.ab };
  const pa = { vus: a.params.vus, duration: a.params.duration, repeat: a.params.repeat, ab: a.params.ab };
  if (JSON.stringify(pb) !== JSON.stringify(pa)) w.push(`参数不同：${JSON.stringify(pb)} vs ${JSON.stringify(pa)}`);
  if (JSON.stringify(b.params.extra ?? {}) !== JSON.stringify(a.params.extra ?? {})) {
    w.push(`场景参数不同：${JSON.stringify(b.params.extra ?? {})} vs ${JSON.stringify(a.params.extra ?? {})}`);
  }
  if (b.target !== a.target) w.push(`目标不同：${b.target} vs ${a.target}（入口变化本身可能就是对比的一部分，例如 cdn）`);
  const ib = b.environment.instanceType;
  const ia = a.environment.instanceType;
  if (ib && ia && ib !== ia) w.push(`实例类型不同：${ib} vs ${ia}`);
  return w;
}

export function buildReport(before: ReportSide, after: ReportSide, opts: { noise?: number; spec?: { title?: string; metrics?: string[]; expect?: ExpectSpec[] } } = {}): ReportData {
  const noise = opts.noise ?? 0.1;
  const b = before.doc;
  const a = after.doc;
  const sameRun = b.runId === a.runId;
  const warnings = comparability(b, a, sameRun);
  for (const [side, d] of [['before', b], ['after', a]] as const) {
    if (d.forced) warnings.unshift(`[FORCED] ${side}（${d.label}）是在前置条件不满足时强制运行的，结论仅供参考`);
    for (const w of d.warnings ?? []) warnings.push(`${side}：${w}`);
  }
  if (sameRun) warnings.push('A/B 两个变体来自同一次运行：服务端分钟汇总按路径签名（含 bypass= 段）近似拆分，主机采样两者共享');

  const environmentDiff: ReportData['environmentDiff'] = [];
  if (!sameRun) {
    const ids = [...new Set([...Object.keys(b.environment.drivers ?? {}), ...Object.keys(a.environment.drivers ?? {})])].sort();
    for (const id of ids) {
      const db = b.environment.drivers?.[id];
      const da = a.environment.drivers?.[id];
      const sb = b.environment.statuses?.[id];
      const sa = a.environment.statuses?.[id];
      if (db !== da || sb !== sa) {
        environmentDiff.push({ module: id, ...(db ? { before: db } : {}), ...(da ? { after: da } : {}), ...(sb ? { statusBefore: sb } : {}), ...(sa ? { statusAfter: sa } : {}) });
      }
    }
  }

  const specMetrics = opts.spec?.metrics ?? a.spec?.metrics ?? b.spec?.metrics ?? [];
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const key of [...specMetrics, ...defaultMetricKeys(b), ...defaultMetricKeys(a)]) {
    const c = canonicalMetric(key, [a, b]);
    if (seen.has(c)) continue;
    seen.add(c);
    keys.push(key);
  }
  const metrics: MetricRow[] = [];
  for (const key of keys) {
    const mb = resolveMetric(b, key);
    const ma = resolveMetric(a, key);
    if (mb.value === undefined && ma.value === undefined && !specMetrics.includes(key)) continue;
    const row: MetricRow = { key, before: mb, after: ma };
    if (mb.value !== undefined && ma.value !== undefined) {
      row.diff = ma.value - mb.value;
      if (mb.value !== 0) row.ratio = ma.value / mb.value;
    }
    metrics.push(row);
  }

  const expect = opts.spec?.expect ?? a.spec?.expect ?? b.spec?.expect ?? [];
  const expectations: ExpectRow[] = expect.map((e) => {
    const mb = resolveMetric(b, e.metric);
    const ma = resolveMetric(a, e.metric);
    const { verdict, band } = judge(e.direction, mb, ma, noise, isLatencyMetric(e.metric) ? 1 : 0);
    return {
      metric: e.metric, direction: e.direction, ...(e.note ? { note: e.note } : {}),
      ...(mb.value !== undefined ? { before: mb.value } : {}), ...(ma.value !== undefined ? { after: ma.value } : {}),
      ...(band !== undefined ? { band } : {}), verdict, verdictText: VERDICT_TEXT[verdict],
    };
  });

  const routeKeys = [...new Set([...Object.keys(b.client.latencyMs ?? {}), ...Object.keys(a.client.latencyMs ?? {})])].sort();
  const routes = routeKeys.map((route) => ({
    route,
    ...(b.client.latencyMs?.[route] ? { before: b.client.latencyMs[route] } : {}),
    ...(a.client.latencyMs?.[route] ? { after: a.client.latencyMs[route] } : {}),
  }));
  const topPaths = (d: ResultDoc) => Object.entries(d.client.paths ?? {}).sort((x, y) => y[1] - x[1]).slice(0, 6).map(([signature, count]) => ({ signature, count }));

  const src = (s: ReportSide) => ({ file: s.file, runId: s.doc.runId, label: s.label, forced: s.doc.forced, startedAt: s.doc.startedAt, target: s.doc.target });
  return {
    schemaVersion: 1, module: a.module, experiment: a.experiment, title: opts.spec?.title ?? a.spec?.title ?? a.experiment,
    generatedAt: new Date().toISOString(), pair: [before.label, after.label],
    sources: { before: src(before), after: src(after) },
    comparable: warnings.filter((w) => w.startsWith('实验不同') || w.startsWith('参数不同') || w.startsWith('实例类型不同')).length === 0,
    warnings, noise, environmentDiff, metrics, expectations, routes,
    paths: { before: topPaths(b), after: topPaths(a) },
  };
}

// ------------------------------------------------------------------------------------- 渲染

const DIRECTION_TEXT: Record<ExpectDirection, string> = {
  down: '下降', up: '上升', flat: '基本不变', 'up-or-flat': '上升或不变', 'down-or-flat': '下降或不变', zero: '为 0', nonzero: '不为 0',
};

function mdEscape(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function fmtDiff(r: MetricRow): string {
  if (r.diff === undefined) return '—';
  return `${r.diff > 0 ? '+' : ''}${fmtNum(r.diff)}`;
}

function fmtRatio(r: MetricRow): string {
  return r.ratio === undefined ? '—' : `×${r.ratio >= 10 ? r.ratio.toFixed(0) : r.ratio.toFixed(2)}`;
}

export function renderMarkdown(d: ReportData): string {
  const [pb, pa] = d.pair;
  const L: string[] = [];
  L.push(`# ${d.module}/${d.experiment} 对比报告：${pb} → ${pa}`, '');
  L.push(`> ${d.title}`, '>', `> 生成于 ${d.generatedAt}；噪声带 ±${Math.round(d.noise * 100)}%（有多轮时取区间的一半与之较大者）`, '');
  for (const side of ['before', 'after'] as const) {
    const s = d.sources[side];
    L.push(`- **${side === 'before' ? pb : pa}**：runId \`${s.runId}\`，${s.startedAt}，目标 ${s.target}${s.forced ? ' **[FORCED]**' : ''} — \`${path.basename(s.file)}\``);
  }
  L.push('');
  if (d.warnings.length) {
    L.push('## 注意', '');
    for (const w of d.warnings) L.push(`- ${w.startsWith('[FORCED]') ? `**${mdEscape(w)}**` : mdEscape(w)}`);
    L.push('');
  }
  L.push('## 结论（按 expect 逐条判定）', '');
  if (!d.expectations.length) L.push('（实验没有声明 expect）', '');
  else {
    L.push(`| 指标 | 预期 | ${pb} | ${pa} | 判定 | 说明 |`, '|---|---|---:|---:|---|---|');
    for (const e of d.expectations) {
      L.push(`| \`${mdEscape(e.metric)}\` | ${DIRECTION_TEXT[e.direction]} | ${fmtNum(e.before)} | ${fmtNum(e.after)} | **${e.verdictText}** | ${mdEscape(e.note ?? '')} |`);
    }
    L.push('');
  }
  L.push('## 环境差异（哪些驱动变了）', '');
  if (!d.environmentDiff.length) L.push(d.sources.before.runId === d.sources.after.runId ? '同一次运行（运行时 A/B），驱动相同。' : '两次运行的驱动与状态相同。', '');
  else {
    L.push(`| 模块 | ${pb} | ${pa} |`, '|---|---|---|');
    for (const e of d.environmentDiff) {
      L.push(`| ${e.module} | ${e.before ?? '—'}（${e.statusBefore ?? '—'}） | ${e.after ?? '—'}（${e.statusAfter ?? '—'}） |`);
    }
    L.push('');
  }
  L.push('## 关键指标', '');
  L.push(`| 指标 | ${pb} | ${pa} | 差值 | 比值 |`, '|---|---:|---:|---:|---:|');
  for (const r of d.metrics) L.push(`| \`${mdEscape(r.key)}\` | ${fmtValue(r.before)} | ${fmtValue(r.after)} | ${fmtDiff(r)} | ${fmtRatio(r)} |`);
  L.push('');
  L.push('## 延迟分布（客户端，毫秒）', '');
  L.push(`| 路由 | 样本 ${pb} / ${pa} | p50 | p95 | p99 | max | 错误 |`, '|---|---:|---:|---:|---:|---:|---:|');
  const pairOf = (x?: number, y?: number) => `${fmtNum(x)} / ${fmtNum(y)}`;
  for (const r of d.routes) {
    L.push(`| ${mdEscape(r.route)} | ${pairOf(r.before?.count, r.after?.count)} | ${pairOf(r.before?.p50, r.after?.p50)} | ${pairOf(r.before?.p95, r.after?.p95)} | ${pairOf(r.before?.p99, r.after?.p99)} | ${pairOf(r.before?.max, r.after?.max)} | ${pairOf(r.before?.errors, r.after?.errors)} |`);
  }
  L.push('');
  L.push('## 路径签名（X-CloudAlbum-Path，去掉 inst / az）', '');
  for (const side of ['before', 'after'] as const) {
    L.push(`**${side === 'before' ? pb : pa}**`, '');
    if (!d.paths[side].length) L.push('- （无）');
    for (const p of d.paths[side]) L.push(`- \`${p.signature}\` × ${p.count}`);
    L.push('');
  }
  L.push('---', '报告只做方向性判断，不预设具体数值；数量级与原因见模块文档第 5 节。', '');
  return L.join('\n');
}

function htmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** 每个路由一组 p50 / p95 / p99 的横向条形（before 灰、after 橙），内联 SVG。 */
function routeSvg(r: ReportData['routes'][number], labels: [string, string]): string {
  const stats = ['p50', 'p95', 'p99'] as const;
  const vals = stats.flatMap((s) => [r.before?.[s] ?? 0, r.after?.[s] ?? 0]);
  const max = Math.max(1, ...vals);
  const rowH = 14;
  const w = 420;
  const lw = 40;
  const parts: string[] = [];
  stats.forEach((s, i) => {
    const y = i * (rowH * 2 + 8);
    parts.push(`<text x="0" y="${y + rowH + 3}" class="t">${s}</text>`);
    ([['before', r.before?.[s]], ['after', r.after?.[s]]] as const).forEach(([side, v], j) => {
      const bw = v ? Math.max(1, ((w - lw - 70) * v) / max) : 0;
      parts.push(`<rect x="${lw}" y="${y + j * rowH}" width="${bw.toFixed(1)}" height="${rowH - 3}" class="${side}"><title>${htmlEscape(labels[j]!)} ${s} ${fmtNum(v)} ms</title></rect>`);
      parts.push(`<text x="${(lw + bw + 4).toFixed(1)}" y="${y + j * rowH + rowH - 4}" class="v">${fmtNum(v)}</text>`);
    });
  });
  const h = stats.length * (rowH * 2 + 8);
  return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${htmlEscape(r.route)}">${parts.join('')}</svg>`;
}

export function renderHtml(d: ReportData): string {
  const md = renderMarkdown(d);
  const tables = md.split('\n## ').slice(1).map((sec) => {
    const [title, ...body] = sec.split('\n');
    const rows = body.filter((l) => l.startsWith('|'));
    const lists = body.filter((l) => l.startsWith('- ') || l.startsWith('**'));
    let html = `<h2>${htmlEscape(title ?? '')}</h2>`;
    if (rows.length > 2) {
      const cells = (l: string) => l.slice(1, -1).split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
      const [head, , ...rest] = rows;
      html += `<table><thead><tr>${cells(head!).map((c) => `<th>${htmlEscape(c)}</th>`).join('')}</tr></thead><tbody>${
        rest.map((l) => `<tr>${cells(l).map((c) => `<td>${htmlEscape(c.replace(/\*\*|`/g, ''))}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
    }
    if (lists.length) html += `<ul>${lists.map((l) => `<li>${htmlEscape(l.replace(/^- /, '').replace(/\*\*|`/g, ''))}</li>`).join('')}</ul>`;
    if (!rows.length && !lists.length) html += `<p>${htmlEscape(body.join(' ').trim())}</p>`;
    return html;
  });
  const charts = d.routes.filter((r) => r.before || r.after).slice(0, 12)
    .map((r) => `<figure><figcaption>${htmlEscape(r.route)}</figcaption>${routeSvg(r, d.pair)}</figure>`).join('');
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${htmlEscape(`${d.module}/${d.experiment} 对比报告`)}</title>
<style>
:root{--bg:#fff;--fg:#1d1d1f;--muted:#6e6e73;--line:#d2d2d7;--before:#8e8e93;--after:#e07a1f}
@media (prefers-color-scheme:dark){:root{--bg:#161617;--fg:#f5f5f7;--muted:#a1a1a6;--line:#3a3a3c;--before:#8e8e93;--after:#ff9f40}}
body{background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,sans-serif;margin:0 auto;max-width:1100px;padding:16px}
table{border-collapse:collapse;width:100%;margin:8px 0 16px;display:block;overflow-x:auto}th,td{border-bottom:1px solid var(--line);padding:4px 8px;text-align:left;white-space:nowrap}
h1{font-size:20px}h2{font-size:16px;margin-top:24px}figure{display:inline-block;margin:8px 16px 8px 0}figcaption{color:var(--muted);font-size:12px}
.before{fill:var(--before)}.after{fill:var(--after)}.t,.v{fill:var(--fg);font-size:10px}.legend span{display:inline-block;width:10px;height:10px;margin:0 4px 0 12px}
</style></head><body>
<h1>${htmlEscape(`${d.module}/${d.experiment} 对比报告：${d.pair[0]} → ${d.pair[1]}`)}</h1>
<p>${htmlEscape(d.title)}</p>
<p class="legend">生成于 ${htmlEscape(d.generatedAt)}<span style="background:var(--before)"></span>${htmlEscape(d.pair[0])}<span style="background:var(--after)"></span>${htmlEscape(d.pair[1])}</p>
${tables.join('\n')}
<h2>延迟分布图（客户端，毫秒）</h2>${charts || '<p>（无）</p>'}
</body></html>
`;
}

// ------------------------------------------------------------------------------------- 入口

export interface ReportArgs {
  module: string;
  experiment?: string;
  before?: string;
  after?: string;
  pair?: [string, string];
  format: Array<'md' | 'json' | 'html'>;
  noise: number;
  results?: string;
  out?: string;
}

export function parseReportArgs(argv: string[]): ReportArgs {
  const { values, positionals } = parseArgs({
    args: argv, allowPositionals: true, strict: true,
    options: {
      experiment: { type: 'string', short: 'e' }, scenario: { type: 'string', short: 's' },
      before: { type: 'string' }, after: { type: 'string' }, pair: { type: 'string' },
      format: { type: 'string' }, noise: { type: 'string' }, results: { type: 'string' }, out: { type: 'string' },
    },
  });
  const formats = (values.format ?? 'md,json').split(',').map((f) => f.trim()).filter(Boolean);
  for (const f of formats) if (!['md', 'json', 'html'].includes(f)) throw new Error(`--format 只支持 md,json,html：${f}`);
  let pair: [string, string] | undefined;
  if (values.pair) {
    const p = values.pair.split(',').map((s) => s.trim());
    if (p.length !== 2 || p.some((s) => !/^[a-z][a-z0-9-]{0,23}(:[AB])?$/.test(s))) throw new Error(`--pair 需要两个标签，例如 before,after 或 after:A,after:B：${values.pair}`);
    pair = [p[0]!, p[1]!];
  }
  const noise = values.noise === undefined ? 0.1 : Number(values.noise);
  if (!Number.isFinite(noise) || noise < 0 || noise > 1) throw new Error(`--noise 需要 0～1：${values.noise}`);
  const experiment = values.experiment ?? values.scenario;
  return {
    module: positionals[0] ?? '', ...(experiment ? { experiment } : {}),
    ...(values.before ? { before: values.before } : {}), ...(values.after ? { after: values.after } : {}), ...(pair ? { pair } : {}),
    format: formats as ReportArgs['format'], noise,
    ...(values.results ? { results: values.results } : {}), ...(values.out ? { out: values.out } : {}),
  };
}

export interface ReportOutcome {
  data: ReportData;
  files: string[];
  markdown: string;
}

export function generateReport(args: ReportArgs, deps: { root?: string; now?: Date } = {}): ReportOutcome {
  const root = deps.root ?? experimentsRoot();
  if (!args.module) throw new Error('用法：npm run exp:report -- <module> [--experiment <id>] [--before latest|<文件>] [--after latest|<文件>] [--pair a,b] [--format md,json,html]');
  const resultsDir = path.join(args.results ?? process.env.EXP_RESULTS_DIR ?? path.join(root, '_results'), args.module);
  const all = loadResults(resultsDir).filter((r) => r.doc.module === args.module);
  if (!all.length && !(args.before && args.after)) throw new Error(`${resultsDir} 下没有结果；先运行 npm run exp -- ${args.module} --label …`);
  const experiment = args.experiment ?? all[all.length - 1]?.doc.experiment ?? '';
  const ofExp = all.filter((r) => r.doc.experiment === experiment);

  let spec: { title?: string; metrics?: string[]; expect?: ExpectSpec[] } | undefined;
  let manifestPair: [string, string] | undefined;
  try {
    const exp = loadManifest(args.module, root).experiments.find((e) => e.id === experiment);
    if (exp) {
      spec = { title: exp.title, ...(exp.metrics ? { metrics: exp.metrics } : {}), ...(exp.expect ? { expect: exp.expect } : {}) };
      manifestPair = exp.pair;
    }
  } catch {
    /* 清单不可用时用结果里保存的 spec */
  }

  let pair = args.pair ?? manifestPair;
  if (!pair) {
    const latest = ofExp[ofExp.length - 1]?.doc;
    const hasBefore = ofExp.some((r) => r.doc.label === 'before');
    const variants = Object.keys(latest?.client.byVariant ?? {});
    if (latest && !hasBefore && variants.includes(`${latest.label}:A`) && variants.includes(`${latest.label}:B`)) {
      pair = [`${latest.label}:A`, `${latest.label}:B`];
    } else {
      pair = ['before', 'after'];
    }
  }
  const before = pickSide(all, experiment, pair[0], args.before, resultsDir);
  const after = pickSide(all, experiment, pair[1], args.after, resultsDir);
  const data = buildReport(before, after, { noise: args.noise, ...(spec ? { spec } : {}) });
  const markdown = renderMarkdown(data);

  const outDir = path.join(args.out ?? path.join(root, '_reports'), args.module);
  mkdirSync(outDir, { recursive: true });
  const base = path.join(outDir, `${fileTimestamp(deps.now ?? new Date())}__${data.experiment}`);
  const files: string[] = [];
  for (const f of args.format) {
    const file = `${base}.${f}`;
    if (f === 'md') writeFileSync(file, markdown);
    if (f === 'json') writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
    if (f === 'html') writeFileSync(file, renderHtml(data));
    files.push(file);
  }
  return { data, files, markdown };
}

export function main(argv: string[] = process.argv.slice(2)): number {
  try {
    const out = generateReport(parseReportArgs(argv));
    for (const e of out.data.expectations) console.error(`${e.verdictText.padEnd(14)} ${e.metric}`);
    for (const f of out.files) console.error(`报告：${f}`);
    return 0;
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }
}

export { findRoute, normRoute };

const invokedDirectly = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) process.exit(main());
