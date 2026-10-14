/**
 * 报告分享副本 P08-S 的渲染（08 P08 “P08-S 分享副本”、§6.11；04 §9.5）：输入 `atl.report/v1`（atl-certs 已按 maskReport 打过码），
 * 输出 `share/<shareId>/index.html` 的完整 HTML 字符串——静态、无脚本、严格 CSP（`default-src 'none'; style-src 'unsafe-inline';
 * img-src data:`），token 内联在文件中。
 *
 * - 版式：摘要、逐步证据、对比实验（内联 SVG，由本模块按记录的数值重新生成，不嵌入报告中的 svg 字段）、清理；
 *   顶部常驻性质声明，底部“平台卸载后此链接失效 · 生成于 …”；不显示导航、按钮与学员邮箱，不含手动确认备注；
 * - 全文先经 `redactDeep(…, 'share')` 再渲染（入口地址、CloudFront 域名、ALB DNS 名、会话名、账号 ID、IP），即使上游已打码也再执行一次；
 * - 所有文本都转义；状态的文字与形状取 src/ui/semantics.ts（全站唯一映射）。
 *
 * 纯函数，不依赖 DOM、React 与 SPA 的运行时；public-pages/build.mjs 把它打成 `share/render-share.mjs`，供 atl-certs 在 Node 中调用。
 */
import { formatSpan } from '../../lib/format';
import { ATTEMPT_STATUS_META, CHECK_RESULT_META, SOURCE_META, STEP_STATE_META, type AttemptStatus, type CheckResult, type StatusMeta, type StepState } from '../../ui/semantics';
import { barsChartSvg, buildBarsChart, buildLadderChart, deltaText, escapeXml, formatMetricValue, ladderChartSvg, type MetricRow, type VariantDecl } from '../experiments/compareModel';
import { BADGE_LEVEL_TEXT, BADGE_STATUS_TEXT, COMPARE_REASON_TEXT, endReasonText, REPORT_CLEANUP_TEXT } from '../sessions/sessionText';
import { redactDeep } from './publicRedact';
import { shapeSvgString } from './shapes';

import { getLocale, msg, setLocale, t, type Locale } from '../../i18n/core';
/** atl.report/v1 中分享副本用到的部分（字段全部可选：上游版本不同也能渲染）。 */
export interface ShareReport {
  schema?: string;
  sessionId?: string;
  revision?: number;
  generatedAt?: string;
  lab?: { id?: string; kind?: string; version?: string; title?: string; catalogVersion?: string; variant?: string; startProfile?: { name?: string } };
  session?: { region?: string; accountIdMasked?: string; readyAt?: string; endedAt?: string; endReason?: string; extensionsUsed?: number; environment?: { reused?: boolean } };
  outcome?: { attemptStatus?: string; checks?: { auto?: number; manual?: number; failed?: number }; driftEvents?: number; trustSummary?: { high?: number; medium?: number; low?: number } };
  timing?: { totalMinutes?: number; activeMinutes?: number };
  steps?: {
    stepId?: string;
    title?: string;
    type?: string;
    state?: string;
    checks?: {
      checkKey?: string;
      title?: string;
      source?: string;
      effective?: string;
      trust?: string;
      provenance?: string;
      ownershipConfirmedLate?: boolean;
      evidenceDigest?: string;
      keyAssertions?: { label?: string; expected?: unknown; actual?: unknown; ok?: boolean }[];
      manual?: { observed?: string; at?: string };
    }[];
  }[];
  experiments?: {
    module?: string;
    experiment?: string;
    variants?: { label?: string; role?: string }[];
    pairs?: { a?: string; b?: string; comparable?: boolean; across?: string[]; reasons?: string[] }[];
    metrics?: { id?: string; label?: string; unit?: string; values?: Record<string, number>; better?: string; source?: string }[];
  }[];
  badge?: { title?: string; level?: string; status?: string; evidenceScore?: number };
  cleanup?: { status?: string; reclaimed?: number; pendingManual?: { resourceType?: string; id?: string; severity?: string; reason?: string }[] };
  [k: string]: unknown;
}

export interface ShareMeta {
  /** 分享副本发布时间（ISO）。 */
  publishedAt: string;
  /** 有效期（ISO；null = 不过期）。 */
  expiresAt?: string | null;
  /** 副本的语言（生成后是静态文件，不随读者切换）；省略时用当前语言。 */
  lang?: Locale;
}

const SH = msg.share;

const pad = (n: number) => String(n).padStart(2, '0');

/** 分享副本里的时间一律写 UTC（读者的时区未知，静态页没有脚本换算）。 */
export function utcStamp(iso: string | null | undefined): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '—';
  const d = new Date(t);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

const e = (v: unknown): string => escapeXml(v === undefined || v === null ? '—' : typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : JSON.stringify(v));

function st(meta: StatusMeta, text = meta.text): string {
  return `<span class="st ${meta.tone}">${shapeSvgString(meta.shape)}<span class="t">${escapeXml(text)}</span></span>`;
}

const UNKNOWN: StatusMeta = {
  get text() {
    return SH.unknown;
  },
  shape: 'ring',
  tone: 'faint',
};
const stepMeta = (s?: string) => (s && s in STEP_STATE_META ? STEP_STATE_META[s as StepState] : UNKNOWN);
const checkMeta = (s?: string) => (s && s in CHECK_RESULT_META ? CHECK_RESULT_META[s as CheckResult] : UNKNOWN);
const attemptMeta = (s?: string) => (s && s in ATTEMPT_STATUS_META ? ATTEMPT_STATUS_META[s as AttemptStatus] : UNKNOWN);

function sourceTag(src?: string): string {
  const m = src && src in SOURCE_META ? SOURCE_META[src as keyof typeof SOURCE_META] : null;
  return m ? `<span class="src"><span aria-hidden="true">${escapeXml(m.symbol)}</span> ${escapeXml(m.text)}</span>` : '<span class="src">—</span>';
}

function summary(r: ShareReport): string {
  const o = r.outcome ?? {};
  const att = attemptMeta(o.attemptStatus);
  const badge = r.badge?.title
    ? `${t(SH.badge, { title: e(r.badge.title) })}${r.badge.level ? ` · ${e(BADGE_LEVEL_TEXT[r.badge.level] ?? r.badge.level)}` : ''}${r.badge.status && r.badge.status !== 'valid' ? t(SH.paren, { text: e(BADGE_STATUS_TEXT[r.badge.status] ?? r.badge.status) }) : ''}`
    : '';
  const tm = r.timing ?? {};
  const s = r.session ?? {};
  const total = typeof tm.totalMinutes === 'number' ? formatSpan(tm.totalMinutes * 60_000) : '—';
  const active = typeof tm.activeMinutes === 'number' ? t(SH.active, { t: formatSpan(tm.activeMinutes * 60_000) }) : '';
  const ext = typeof s.extensionsUsed === 'number' ? t(SH.extensions, { n: s.extensionsUsed }) : '';
  const c = o.checks ?? {};
  const trust = o.trustSummary;
  const cleanup = r.cleanup?.status ? REPORT_CLEANUP_TEXT[r.cleanup.status] ?? r.cleanup.status : '—';
  const tiles: [string, string][] = [
    [SH.conclusion, `${st(att)}${badge}`],
    [SH.duration, `${e(t(SH.durationValue, { total }))}${e(active)}${e(ext)}`],
    [
      SH.checks,
      `${e(t(SH.checksValue, { auto: c.auto ?? 0, manual: c.manual ?? 0, failed: c.failed ?? 0 }))}${typeof o.driftEvents === 'number' && o.driftEvents ? e(t(SH.drift, { n: o.driftEvents })) : ''}${trust ? e(t(SH.trust, { high: trust.high ?? 0, medium: trust.medium ?? 0, low: trust.low ?? 0 })) : ''}`,
    ],
    [SH.cleanup, e(cleanup)],
    [
      SH.environment,
      `${s.environment?.reused ? SH.reused : SH.fresh} · <span class="mono">${e(s.region)}</span>${e(t(SH.account, { acct: s.accountIdMasked ?? '••••' }))}${r.lab?.startProfile?.name ? t(SH.startProfile, { name: `<span class="mono">${e(r.lab.startProfile.name)}</span>` }) : ''}`,
    ],
    [SH.end, e(t(SH.endValue, { reason: endReasonText(s.endReason), ready: utcStamp(s.readyAt), ended: utcStamp(s.endedAt) }))],
  ];
  return `<section class="sec" aria-labelledby="h-sum"><h2 id="h-sum">${e(SH.summary)}</h2><div class="statgrid">${tiles.map(([k, v]) => `<div class="stat"><span class="k">${k}</span><span class="v">${v}</span></div>`).join('')}</div></section>`;
}

function steps(r: ShareReport): string {
  const list = r.steps ?? [];
  if (!list.length) return `<section class="sec" aria-labelledby="h-steps"><h2 id="h-steps">${e(SH.steps)}</h2><p class="muted">${e(SH.noSteps)}</p></section>`;
  const body = list
    .map((s, i) => {
      const meta = stepMeta(s.state);
      const rows = (s.checks ?? [])
        .map((c) => {
          const cm = checkMeta(c.effective);
          const asserts = (c.keyAssertions ?? []).map((a) => t(SH.assertion, { mark: a.ok ? '✓' : '✗', label: e(a.label), expected: e(a.expected), actual: e(a.actual) })).join('<br>');
          const notes = [
            c.provenance && c.provenance !== 'this-session' ? e(SH.inherited) : c.provenance === 'this-session' ? e(SH.thisSession) : '',
            c.ownershipConfirmedLate ? e(SH.ownershipLate) : '',
            c.manual?.observed ? t(e(SH.manualObserved), { v: e(c.manual.observed) }) : '',
          ]
            .filter(Boolean)
            .join(' · ');
          return `<tr><td>${st(cm)}</td><td>${sourceTag(c.source)}</td><td>${e(c.title ?? c.checkKey)}${asserts ? `<div class="small muted">${asserts}</div>` : ''}${notes ? `<div class="small muted">${notes}</div>` : ''}</td><td class="mono small">${c.evidenceDigest ? `${e(c.evidenceDigest.slice(0, 15))}…` : '—'}</td></tr>`;
        })
        .join('');
      const table = rows
        ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th scope="col">${e(SH.colResult)}</th><th scope="col">${e(SH.colSource)}</th><th scope="col">${e(SH.colCheck)}</th><th scope="col">${e(SH.colDigest)}</th></tr></thead><tbody>${rows}</tbody></table></div>`
        : '';
      return `<div class="step"><h3>${st(meta, '')}<span>${i + 1} ${e(s.title ?? s.stepId)}</span><span class="small muted">${e(s.type ?? '')} · ${escapeXml(meta.text)}</span></h3>${table}</div>`;
    })
    .join('');
  return `<section class="sec" aria-labelledby="h-steps"><h2 id="h-steps">${e(SH.steps)}</h2>${body}</section>`;
}

function roleOf(v?: string): VariantDecl['role'] {
  return v === 'baseline' || v === 'treatment' || v === 'single' ? v : 'treatment';
}

function experiments(r: ShareReport): string {
  const list = r.experiments ?? [];
  if (!list.length) return `<section class="sec" aria-labelledby="h-exp"><h2 id="h-exp">${e(SH.experiments)}</h2><p class="muted">${e(SH.noExperiments)}</p></section>`;
  const body = list
    .map((x, xi) => {
      const variants: VariantDecl[] = (x.variants ?? []).filter((v) => v.label).map((v) => ({ label: String(v.label), role: roleOf(v.role) }));
      const metrics: MetricRow[] = (x.metrics ?? []).map((m) => ({
        id: String(m.id ?? ''),
        label: String(m.label ?? m.id ?? ''),
        unit: String(m.unit ?? ''),
        better: m.better === 'lower' || m.better === 'higher' ? m.better : 'neutral',
        values: m.values ?? {},
      }));
      const single = variants.length === 1;
      const head = `<tr><th scope="col">${e(SH.colMetric)}</th>${variants.map((v) => `<th scope="col" class="num">${e(v.label)}</th>`).join('')}${single ? '' : `<th scope="col">${e(SH.colDelta)}</th>`}</tr>`;
      const base = variants.find((v) => v.role === 'baseline') ?? variants[0];
      const other = variants.find((v) => v !== base);
      const rows = metrics
        .map(
          (m) =>
            `<tr><td>${e(m.label)}</td>${variants.map((v) => `<td class="num">${e(formatMetricValue(m.values[v.label], m.unit))}</td>`).join('')}${
              single ? '' : `<td>${e(base && other ? deltaText(m.values[base.label], m.values[other.label], m.unit, m.label) : '—')}</td>`
            }</tr>`,
        )
        .join('');
      const pairs = (x.pairs ?? [])
        .map((p) => `<li>${e(p.a)} ↔ ${e(p.b)}：${p.comparable ? e(SH.comparable) : e(t(SH.notComparable, { list: (p.reasons ?? []).map((c) => COMPARE_REASON_TEXT[c] ?? c).join(SH.reasonSep) }))}${p.across?.length ? e(SH.acrossTypes) : ''}</li>`)
        .join('');
      const bars = buildBarsChart(metrics, variants);
      const ladder = buildLadderChart(metrics, variants);
      return `<div class="exp"><h3>${e(x.module)} / ${e(x.experiment)}</h3>
<p class="small muted">${e(t(SH.variants, { list: variants.map((v) => t(SH.variantItem, { label: v.label, role: v.role })).join(SH.listSep) || '—' }))}</p>
${pairs ? `<ul class="small plain">${pairs}</ul>` : ''}
${rows ? `<div class="tbl-wrap"><table class="tbl"><caption class="sr">${e(t(SH.metricsCaption, { name: `${x.module} / ${x.experiment}` }))}</caption><thead>${head}</thead><tbody>${rows}</tbody></table></div>` : `<p class="muted small">${e(SH.noMetrics)}</p>`}
${bars ? `<figure>${barsChartSvg(bars, `exp${xi}`)}</figure>` : ''}${ladder ? `<figure>${ladderChartSvg(ladder)}</figure>` : ''}</div>`;
    })
    .join('');
  return `<section class="sec" aria-labelledby="h-exp"><h2 id="h-exp">${e(SH.experiments)}</h2>${body}<p class="small muted">${e(SH.directionNote)}</p></section>`;
}

function cleanup(r: ShareReport): string {
  const c = r.cleanup ?? {};
  const status = c.status ? REPORT_CLEANUP_TEXT[c.status] ?? c.status : '—';
  const pending = (c.pendingManual ?? [])
    .map((p) => `<tr><td class="mono small">${e(p.resourceType)}</td><td class="mono small">${e(p.id)}</td><td>${e(p.severity && p.severity in SH.severity ? SH.severity[p.severity as keyof typeof SH.severity] : p.severity)}</td><td>${e(p.reason)}</td></tr>`)
    .join('');
  return `<section class="sec" aria-labelledby="h-clean"><h2 id="h-clean">${e(SH.cleanup)}</h2><p>${e(status)}${typeof c.reclaimed === 'number' ? e(t(SH.reclaimed, { n: c.reclaimed })) : ''}</p>${
    pending
      ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th scope="col">${e(SH.colType)}</th><th scope="col">${e(SH.colResource)}</th><th scope="col">${e(SH.colLevel)}</th><th scope="col">${e(SH.colReason)}</th></tr></thead><tbody>${pending}</tbody></table></div>`
      : ''
  }</section>`;
}

export const SHARE_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'";

export const SHARE_CSS = `
:root{--bg:#F6F6F4;--surface:#FFFFFF;--surface-2:#EFEEE8;--border:#DAD8D0;--border-strong:#8A867B;--text:#1C1D1F;--text-2:#4A4D55;--text-3:#63666E;
--st-pass:#1B703F;--st-pass-soft:#E2F2E7;--st-manual:#6A3EA1;--st-fail:#B3261E;--st-drift:#A8380A;--st-drift-soft:#FCE9DD;--st-pending:#1F5FAD;--st-error:#5A606B;--st-needs:#6A3EA1;--st-stale:#8A6100;--st-locked:#8C9098;
--accent:#0F6E6E;--viz-before:#8C8F96;--viz-after:#0F6E6E;--viz-third:#9A6B1F;--viz-grid:#E4E2DA;
--font-sans:"PingFang SC","Hiragino Sans GB","Microsoft YaHei UI","Microsoft YaHei","Noto Sans SC","Source Han Sans SC",system-ui,sans-serif;
--font-mono:"JetBrains Mono","Cascadia Mono","SFMono-Regular",Consolas,"Noto Sans Mono CJK SC",Menlo,monospace;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#141517;--surface:#1B1C1F;--surface-2:#232428;--border:#34363B;--border-strong:#6E7179;--text:#E9E7E2;--text-2:#B6B4AE;--text-3:#96948F;
--st-pass:#4CB97A;--st-pass-soft:#163222;--st-manual:#B08BE0;--st-fail:#F0716A;--st-drift:#F08A4B;--st-drift-soft:#3A2214;--st-pending:#6FA3E6;--st-error:#9AA0AA;--st-needs:#B08BE0;--st-stale:#D9A93A;--st-locked:#6F737B;
--accent:#4FB3A9;--viz-before:#7D8088;--viz-after:#4FB3A9;--viz-third:#D1A45A;--viz-grid:#2C2E32;color-scheme:dark}}
*,*::before,*::after{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.6 var(--font-sans)}
main{max-width:960px;margin:0 auto;padding:24px 16px 48px;display:grid;gap:20px;min-width:0}
main>*{min-width:0}
h1{font-size:20px;line-height:1.4;margin:0;font-weight:600}h2{font-size:15px;margin:0;font-weight:600;padding-bottom:6px;border-bottom:1px solid var(--border)}
h3{font-size:14px;margin:0 0 6px;font-weight:600;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
p{margin:0}.small{font-size:12px}.muted{color:var(--text-2)}.faint{color:var(--text-3)}.mono{font-family:var(--font-mono);font-size:.92em}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.nature{border:1px solid var(--border);border-left:4px solid var(--st-drift);background:var(--surface);border-radius:4px;padding:10px 12px;color:var(--text-2)}
.sec{display:grid;gap:10px;min-width:0}.sec>*{min-width:0}
.statgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,220px),1fr));border:1px solid var(--border);border-radius:4px;background:var(--surface)}
.stat{padding:10px 12px;border-right:1px solid var(--border);border-bottom:1px solid var(--border);display:grid;gap:2px;min-width:0;overflow-wrap:anywhere}
.stat .k{font-size:12px;color:var(--text-2)}.stat .v{font-size:13.5px}
.tbl-wrap{overflow-x:auto;border:1px solid var(--border);border-radius:4px;background:var(--surface)}
table.tbl{border-collapse:collapse;width:100%;font-size:13px}
.tbl th,.tbl td{padding:6px 10px;border-bottom:1px solid var(--border);text-align:left;vertical-align:top;overflow-wrap:anywhere}
.tbl th{background:var(--surface-2);font-weight:600;font-size:12px;color:var(--text-2);white-space:nowrap}.tbl tr:last-child td{border-bottom:0}
.tbl .num{text-align:right;font-variant-numeric:tabular-nums}
.step,.exp{display:grid;gap:6px;padding-bottom:10px;border-bottom:1px dashed var(--border)}
.st{display:inline-flex;align-items:center;gap:5px;white-space:nowrap}.st .t{color:var(--text)}
.st.pass{color:var(--st-pass)}.st.fail{color:var(--st-fail)}.st.pend{color:var(--st-pending)}.st.drift{color:var(--st-drift)}.st.manual{color:var(--st-manual)}
.st.needs{color:var(--st-needs)}.st.err{color:var(--st-error)}.st.stale{color:var(--st-stale)}.st.lock{color:var(--st-locked)}.st.mut{color:var(--text-2)}.st.faint{color:var(--text-3)}
.shp{width:12px;height:12px;flex:none;display:inline-block}.shp .inv{stroke:var(--surface)}.shp .invf{fill:var(--surface)}
.src{font-family:var(--font-mono);font-size:11.5px;color:var(--text-2);white-space:nowrap}
ul.plain{margin:0;padding-left:18px}
figure{margin:4px 0;border:1px solid var(--border);border-radius:4px;background:var(--surface);padding:8px}
.chart{display:block;width:100%;max-width:760px;height:auto}.chart text{fill:var(--text-2);font-size:11px;font-family:var(--font-sans)}
.chart .grid{stroke:var(--viz-grid)}.chart .b{fill:var(--viz-before)}.chart .a{fill:var(--viz-after)}.chart .t3{fill:var(--viz-third)}
.chart path.ln{fill:none;stroke-width:2}.chart path.ln.b{stroke:var(--viz-before)}.chart path.ln.a{stroke:var(--viz-after)}.chart path.ln.t3{stroke:var(--viz-third)}.chart path.dash{stroke-dasharray:6 3}
footer{font-size:12px;color:var(--text-3);border-top:1px solid var(--border);padding-top:10px}
@media print{@page{size:A4 portrait;margin:14mm}body{background:#fff;color:#000}main{max-width:none;padding:0}tr,figure,table,.step{break-inside:avoid}}
`;

/**
 * 分享副本旁的 `report.json`（与 atl-certs 的布局一致：`share/<shareId>/index.html` + `report.json`）：强制打码、去掉手动确认备注与
 * 报告中的 svg（图表由页面按数值重画），并标记 `redactedCopy: true`。
 */
export function shareReportJson(input: ShareReport): string {
  const r = redactDeep(input, 'share') as ShareReport & { experiments?: { charts?: unknown }[] };
  const steps = (r.steps ?? []).map((s) => ({
    ...s,
    checks: (s.checks ?? []).map((c) => (c.manual ? { ...c, manual: { ...(c.manual as Record<string, unknown>), note: '' } } : c)),
  }));
  const experiments = (r.experiments ?? []).map((x) => {
    const { charts: _charts, ...rest } = x as Record<string, unknown>;
    return rest;
  });
  return `${JSON.stringify({ ...r, steps, experiments, redactedCopy: true }, null, 2)}\n`;
}

export { redactDeep, redactText } from './publicRedact';

/** 渲染分享副本（完整 HTML 文档）。 */
export function renderShareHtml(input: ShareReport, meta: ShareMeta): string {
  const previous = getLocale();
  if (meta.lang && meta.lang !== previous) setLocale(meta.lang, { persist: false });
  try {
    return renderShareDocument(input, meta);
  } finally {
    if (meta.lang && meta.lang !== previous) setLocale(previous, { persist: false });
  }
}

function renderShareDocument(input: ShareReport, meta: ShareMeta): string {
  const r = redactDeep(input, 'share');
  const lab = r.lab ?? {};
  const title = t(SH.title, { id: lab.id ?? SH.lab });
  const expires = meta.expiresAt ? t(SH.expiresAt, { t: e(utcStamp(meta.expiresAt)) }) : e(SH.noExpiry);
  return `<!doctype html>
<html lang="${getLocale()}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta http-equiv="Content-Security-Policy" content="${escapeXml(SHARE_CSP)}">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<title>${e(title)}</title>
<style>${SHARE_CSS}</style>
</head>
<body>
<main>
<p class="nature" role="note">${e(SH.nature)}</p>
<header><h1>${e(lab.id)} · ${e(lab.title)}</h1><p class="small muted">${t(e(SH.header), { rev: e(r.revision ?? 1), generated: e(utcStamp(r.generatedAt)), version: e(lab.version), variant: e(lab.variant ?? 'default') })}</p></header>
${summary(r)}
${steps(r)}
${experiments(r)}
${cleanup(r)}
<footer><p>${t(e(SH.footer1), { t: e(utcStamp(meta.publishedAt)), expires })}</p><p>${e(SH.footer2)}</p></footer>
</main>
</body>
</html>
`;
}
