/**
 * Server-rendered inline SVG charts for reports (04 §9.2): no scripts, no external fonts, values only from records.
 * Bars: one group per metric, one bar per variant label; differences within the noise band are not called out here —
 * the text explains them.
 */
export function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

const PALETTE = ['#4c6ef5', '#12b886', '#f59f00', '#e64980', '#7950f2'];

export function barsSvg(metrics: { label: string; unit: string; values: Record<string, number> }[], labels: string[]): string {
  const width = 640;
  const rowH = 22;
  const groupGap = 18;
  const left = 170;
  const used = labels.filter((l) => metrics.some((m) => m.values[l] !== undefined));
  const height = 24 + metrics.length * (used.length * rowH + groupGap) + 20;
  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="100%" role="img" aria-label="对比实验指标">`);
  parts.push('<style>text{font:12px system-ui,sans-serif;fill:currentColor}.v{font-size:11px}</style>');
  let y = 20;
  used.forEach((l, i) => parts.push(`<rect x="${left + i * 90}" y="4" width="10" height="10" fill="${PALETTE[i % PALETTE.length]}"/><text x="${left + 14 + i * 90}" y="13">${escapeXml(l)}</text>`));
  for (const m of metrics) {
    const max = Math.max(1e-9, ...Object.values(m.values).map((v) => Math.abs(v)));
    parts.push(`<text x="0" y="${y + 14}">${escapeXml(m.label)}</text>`);
    used.forEach((l, i) => {
      const v = m.values[l];
      if (v === undefined) return;
      const w = Math.max(1, Math.round((Math.abs(v) / max) * (width - left - 80)));
      const yy = y + i * rowH;
      parts.push(`<rect x="${left}" y="${yy + 4}" width="${w}" height="${rowH - 8}" fill="${PALETTE[i % PALETTE.length]}"/>`);
      parts.push(`<text class="v" x="${left + w + 6}" y="${yy + 15}">${escapeXml(formatValue(v, m.unit))}</text>`);
    });
    y += used.length * rowH + groupGap;
  }
  parts.push('</svg>');
  return parts.join('');
}

function formatValue(v: number, unit: string): string {
  if (unit === 'ratio') return `${Math.round(v * 1000) / 10}%`;
  if (Number.isInteger(v)) return String(v);
  return String(Math.round(v * 100) / 100);
}
