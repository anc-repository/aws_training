/**
 * 横向条形图（I6 f）：报告与学习页里“各项的量”的比较（例如各领域完成数、各步骤用时）。
 *
 * 用 <table> 实现：每行是 行标题（标签）+ 条（装饰 SVG）+ 数值文字，所以图表本身就是“数据表视图”（08 §6.12、§8.4），
 * 读屏按表格朗读；条的宽度用 SVG 属性表达（不写 style 属性，CSP style-src 'self'），窄屏随列宽伸缩、页面不横向滚动。
 * 颜色按角色：after（默认，--viz-after）/ before（--viz-before）/ third（--viz-third），不用红绿；数值与标签用文字色。
 * 悬停：每个条带 <title>（“标签：数值”）。
 */
import type { ReactNode } from 'react';
import { useVisualI18n } from '../glyphs/visualI18n';
import './charts.css';

export interface BarDatum {
  key: string;
  label: ReactNode;
  value: number;
  /** 显示的数值文字（默认 Intl 数字）。 */
  display?: string;
  tone?: 'after' | 'before' | 'third';
  /** 标签前的图标（例如 <ServiceGlyph size={16}/>）。 */
  icon?: ReactNode;
  /** 悬停提示用的纯文字标签（label 不是字符串时）。 */
  text?: string;
}

export interface BarChartProps {
  data: readonly BarDatum[];
  /** 表格标题（必填：图表的名称）。 */
  caption: string;
  /** 只给读屏（标题已在页面上）。 */
  captionHidden?: boolean;
  /** 坐标上限（默认取数据最大值）。 */
  max?: number;
  /** 列标题（默认“項目 / 値”）。 */
  itemHeader?: string;
  valueHeader?: string;
}

export function barWidths(data: readonly Pick<BarDatum, 'value'>[], max?: number): number[] {
  const top = max ?? Math.max(0, ...data.map((d) => d.value));
  return data.map((d) => (top > 0 ? Math.round(Math.max(0, Math.min(1, d.value / top)) * 1000) / 10 : 0));
}

export function BarChart({ data, caption, captionHidden, max, itemHeader, valueHeader }: BarChartProps) {
  const i18n = useVisualI18n();
  const widths = barWidths(data, max);
  return (
    <table className="bchart">
      <caption className={captionHidden ? 'sr' : 'bchart-cap'}>{caption}</caption>
      <thead className="sr">
        <tr>
          <th scope="col">{itemHeader ?? i18n.t('visual.chart.item')}</th>
          <td />
          <th scope="col">{valueHeader ?? i18n.t('visual.chart.value')}</th>
        </tr>
      </thead>
      <tbody>
        {data.map((d, i) => {
          const shown = d.display ?? i18n.number(d.value);
          const w = widths[i];
          const tip = `${d.text ?? (typeof d.label === 'string' ? d.label : d.key)}: ${shown}`;
          return (
            <tr key={d.key} data-key={d.key}>
              <th scope="row" className="bchart-label">
                {d.icon ? <span className="bchart-icon">{d.icon}</span> : null}
                <span>{d.label}</span>
              </th>
              <td className="bchart-bar" aria-hidden="true">
                <svg viewBox="0 0 100 10" preserveAspectRatio="none" focusable="false">
                  <title>{tip}</title>
                  <rect className="bchart-track" x="0" y="0" width="100" height="10" />
                  {w > 0 ? <rect className={`bchart-fill ${d.tone ?? 'after'}`} x="0" y="0" width={Math.max(w, 0.8)} height="10" /> : null}
                </svg>
              </td>
              <td className="bchart-val">{shown}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
