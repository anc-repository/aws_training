/**
 * 简易图表（08 §5.4 VariantBarChart / LadderChart、§6.12）：几何来自 compareModel（与分享副本共用），这里用 React 渲染 SVG。
 * `role="img"` + `<title>` / `<desc>`；取色只用类名（baseline 灰、treatment 青瓷、第三色），不用红绿；“查看数据表”是读屏视图。
 */
import { useId } from 'react';
import type { BarsChart, LadderChart } from './compareModel';

export function BarsChartSvg({ chart }: { chart: BarsChart }) {
  const id = useId();
  return (
    <svg className="chart" viewBox={`0 0 ${chart.width} ${chart.height}`} role="img" aria-labelledby={`${id}-t ${id}-d`}>
      <title id={`${id}-t`}>{chart.title}</title>
      <desc id={`${id}-d`}>{chart.desc}</desc>
      {chart.groups.map((g, gi) => (
        <g key={gi}>
          <text x={0} y={g.textY}>
            {g.label}
          </text>
          {g.bars.map((b) => (
            <g key={b.label}>
              <rect className={b.cls} x={b.x} y={b.y} width={b.w} height={b.h} />
              <text x={b.textX} y={b.textY}>
                {b.valueText}
              </text>
            </g>
          ))}
          <line className="grid" x1={chart.labelWidth} x2={chart.labelWidth} y1={g.gridY1} y2={g.gridY2} />
        </g>
      ))}
    </svg>
  );
}

export function LadderChartSvg({ chart }: { chart: LadderChart }) {
  return (
    <svg className="chart" viewBox={`0 0 ${chart.width} ${chart.height}`} role="img" aria-label={chart.title}>
      <line className="grid" x1={chart.x0} x2={chart.x1} y1={chart.baseY} y2={chart.baseY} />
      {chart.yTicks.map((t, i) => (
        <g key={i}>
          <line className="grid" x1={chart.x0} x2={chart.x1} y1={t.y} y2={t.y} />
          <text x={chart.x0 - 8} y={t.y + 4} textAnchor="end">
            {t.text}
          </text>
        </g>
      ))}
      {chart.series.map((s) => (
        <g key={s.label}>
          <path className={`ln ${s.cls}${s.dashed ? ' dash' : ''}`} d={s.path} />
          {s.points.map((p, i) => (
            <circle key={i} className={s.cls} cx={p.x} cy={p.y} r={4} />
          ))}
        </g>
      ))}
      {chart.xTicks.map((t) => (
        <text key={t.text} x={t.x} y={chart.height - 6} textAnchor="middle">
          {t.text}
        </text>
      ))}
    </svg>
  );
}
