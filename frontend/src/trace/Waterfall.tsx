// 瀑布图（总纲 7.4 第 3 条）：按“浏览器 → 边缘 → 入口链 → 各模块”画条。
// 浏览器侧网络时间来自 Resource Timing；服务端各段来自 Server-Timing（只有耗时没有起点，从服务端开始处画“耗时条”）；
// 边缘段来自 CloudFront 追加的 cdn-* 项。
import type { CapabilitiesResponse } from '@cloudalbum/contracts';
import { parsePathValue, parseTimingDesc, isModuleId } from '@cloudalbum/contracts';
import { segmentTone, type ChipTone } from './PathChips';
import { findFetchTiming } from './resourceTiming';
import type { TraceEntry } from './TraceStore';

export interface WaterfallRow {
  key: string;
  label: string;
  start: number;
  dur: number;
  tone: ChipTone | 'browser' | 'total';
  note?: string;
}

export function buildWaterfall(entry: TraceEntry, caps?: CapabilitiesResponse | null, timing?: PerformanceResourceTiming): WaterfallRow[] {
  const rows: WaterfallRow[] = [];
  const browserTotal = timing ? timing.responseEnd - timing.startTime : entry.durationMs;
  rows.push({ key: 'browser', label: '浏览器 · 总计', start: 0, dur: Math.max(0, browserTotal), tone: 'browser' });

  let serverStart = 0;
  if (timing && timing.requestStart > 0) {
    const t0 = timing.startTime;
    const dns = timing.domainLookupEnd - timing.domainLookupStart;
    const connect = timing.connectEnd - timing.connectStart;
    if (dns > 0.05) rows.push({ key: 'dns', label: '浏览器 · DNS', start: timing.domainLookupStart - t0, dur: dns, tone: 'browser' });
    if (connect > 0.05) rows.push({ key: 'connect', label: '浏览器 · 连接/TLS', start: timing.connectStart - t0, dur: connect, tone: 'browser' });
    rows.push({ key: 'wait', label: '浏览器 · 等待首字节', start: timing.requestStart - t0, dur: timing.responseStart - timing.requestStart, tone: 'browser' });
    rows.push({ key: 'download', label: '浏览器 · 下载', start: timing.responseStart - t0, dur: timing.responseEnd - timing.responseStart, tone: 'browser' });
    serverStart = timing.requestStart - t0;
    for (const s of timing.serverTiming ?? []) {
      if (!s.name.startsWith('cdn-')) continue;
      rows.push({ key: `edge-${s.name}`, label: `边缘 · ${s.name}`, start: serverStart, dur: s.duration, tone: 'aws', ...(s.description ? { note: s.description } : {}) });
    }
  }

  if (entry.path.entry) {
    rows.push({ key: 'entry', label: `入口 · ${entry.path.entry.replace(/>/g, '→')}`, start: serverStart, dur: 0, tone: /cloudfront|alb|waf|apigw/.test(entry.path.entry) ? 'aws' : 'local' });
  }
  const total = entry.serverTiming.find((m) => m.name === 'total');
  if (total?.dur !== undefined) rows.push({ key: 'total', label: '服务端 · total', start: serverStart, dur: total.dur, tone: 'total' });
  for (const m of entry.serverTiming) {
    if (m.name === 'total') continue;
    const desc = m.desc ? parseTimingDesc(m.desc) : undefined;
    let tone: WaterfallRow['tone'] = 'local';
    if (isModuleId(m.name)) {
      const seg = entry.path.modules.find((s) => s.module === m.name);
      const value = seg ?? { module: m.name, ...parsePathValue(desc?.value ?? '') };
      tone = segmentTone(value, caps);
    } else if (m.name.startsWith('cdn-')) {
      tone = 'aws';
    }
    rows.push({
      key: `st-${m.name}`,
      label: m.name,
      start: serverStart,
      dur: m.dur ?? 0,
      tone,
      ...(m.desc ? { note: m.desc } : {}),
    });
  }
  return rows;
}

export function Waterfall({ entry, caps }: { entry: TraceEntry; caps?: CapabilitiesResponse | null }) {
  const timing = findFetchTiming(entry.url, entry.startTime);
  const rows = buildWaterfall(entry, caps, timing);
  const span = Math.max(1, ...rows.map((r) => r.start + r.dur));
  return (
    <div className="wf" role="table" aria-label="请求瀑布图">
      {rows.map((r) => (
        <div className="wf-row" role="row" key={r.key}>
          <span className="wf-label" role="cell" title={r.note ? `${r.label} · ${r.note}` : r.label}>
            {r.label}
            {r.note ? <span className="subtle"> {r.note}</span> : null}
          </span>
          <span className="wf-track" role="cell" aria-hidden="true">
            <span
              className={`wf-bar t-${r.tone === 'meta' || r.tone === 'degraded' ? 'local' : r.tone}`}
              style={{ left: `${(r.start / span) * 100}%`, width: `${Math.max(0.4, (r.dur / span) * 100)}%` }}
            />
          </span>
          <span className="num" role="cell" style={{ textAlign: 'right' }}>{r.dur ? `${r.dur.toFixed(1)} ms` : '—'}</span>
        </div>
      ))}
      {!timing && (
        <p className="subtle" style={{ marginTop: 6 }}>
          浏览器的分阶段时间不可用（Resource Timing 里没有这次请求，或跨域响应缺少 Timing-Allow-Origin）；服务端各段只有耗时，没有起点。
        </p>
      )}
    </div>
  );
}

/** 两两对比：每一段的耗时差（总纲 7.4 第 4 条） */
export function compareSegments(a: TraceEntry, b: TraceEntry): Array<{ name: string; a?: number; b?: number; delta?: number }> {
  const names = new Set<string>(['browser']);
  for (const m of a.serverTiming) names.add(m.name);
  for (const m of b.serverTiming) names.add(m.name);
  const val = (e: TraceEntry, n: string) => (n === 'browser' ? e.durationMs : e.serverTiming.find((m) => m.name === n)?.dur);
  return [...names].map((name) => {
    const va = val(a, name);
    const vb = val(b, name);
    return {
      name,
      ...(va !== undefined ? { a: va } : {}),
      ...(vb !== undefined ? { b: vb } : {}),
      ...(va !== undefined && vb !== undefined ? { delta: vb - va } : {}),
    };
  });
}
