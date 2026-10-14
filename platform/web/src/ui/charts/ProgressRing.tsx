/**
 * 进度环（I6 f）：报告与学习页的完成度、掌握度。单一数值 → 环形 + 中心的 Intl 百分比（≥ 40px 时显示）。
 * 颜色：完成部分 --viz-after（单系列，08 §6.12），底环 --viz-grid（装饰）；tone="pass" 用 --st-pass，"neutral" 用 --text-2。
 * role="img" + “标签：60%”；数值另有可见文字时可设 decorative。
 */
import { useVisualI18n } from '../glyphs/visualI18n';
import './charts.css';

export interface ProgressRingProps {
  value: number;
  /** 满值（默认 1：value 为比例；百分比时传 100）。 */
  max?: number;
  size?: number;
  /** 读屏名称，例如“必修卡片”。 */
  label: string;
  /** 中心显示百分比（默认 size ≥ 40 时显示）。 */
  showValue?: boolean;
  tone?: 'accent' | 'pass' | 'neutral';
  decorative?: boolean;
}

export function ringGeometry(value: number, max: number, size: number) {
  const ratio = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
  const stroke = Math.max(2, Math.round(size * 0.11 * 10) / 10);
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  return { ratio, stroke, r, c, dash: Math.round(c * ratio * 100) / 100 };
}

export function ProgressRing({ value, max = 1, size = 48, label, showValue, tone = 'accent', decorative }: ProgressRingProps) {
  const i18n = useVisualI18n();
  const { ratio, stroke, r, c, dash } = ringGeometry(value, max, size);
  const pct = i18n.number(ratio, { style: 'percent', maximumFractionDigits: 0 });
  const show = showValue ?? size >= 40;
  const half = size / 2;
  const a11y = decorative ? { 'aria-hidden': true as const } : { role: 'img', 'aria-label': i18n.t('visual.chart.progress', { label, value: pct }) };
  return (
    <svg className={`pring ${tone}`} width={size} height={size} viewBox={`0 0 ${size} ${size}`} focusable="false" data-ratio={ratio.toFixed(3)} {...a11y}>
      <circle className="pring-track" cx={half} cy={half} r={r} strokeWidth={stroke} />
      {ratio > 0 ? (
        <circle
          className="pring-fill"
          cx={half}
          cy={half}
          r={r}
          strokeWidth={stroke}
          strokeDasharray={`${dash} ${Math.round(c * 100) / 100}`}
          transform={`rotate(-90 ${half} ${half})`}
        />
      ) : null}
      {show ? (
        <text className="pring-text" x={half} y={half} textAnchor="middle" dominantBaseline="central" fontSize={Math.max(10, Math.round(size * 0.24))}>
          {pct}
        </text>
      ) : null}
    </svg>
  );
}
