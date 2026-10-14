/**
 * 卡片指标的图标 + 短标签（I6 c）：难度（四段递增条）、时长（时钟 + Intl 分钟）、费用档位（等宽 $ 数量，08 §6.6 不用红绿）、
 * 部署等级（速度表指针，A 快 → D 慢，05 §3.4 不写分钟数）。
 * 图形只是辅助：可见文字是短标签，读屏另有视觉隐藏的指标名（“难易度：中级”）；compact 时只有图标，role="img" + 完整说明。
 */
import { useVisualI18n, type VisualI18n, type VisualKey } from '../glyphs/visualI18n';
import './charts.css';

export type DifficultyValue = 'intro' | 'beginner' | 'intermediate' | 'advanced';
export type CostTierValue = 'low' | 'medium' | 'high';
export type ProvisionValue = 'A' | 'B' | 'C' | 'D';

export type MetricSpec =
  | { kind: 'difficulty'; value: DifficultyValue }
  | { kind: 'duration'; minutes: number }
  | { kind: 'cost'; value: CostTierValue }
  | { kind: 'provision'; value: ProvisionValue };

export type MetricIconProps = MetricSpec & {
  /** 只显示图标（role="img" + aria-label）。 */
  compact?: boolean;
};

const DIFF_LEVEL: Readonly<Record<DifficultyValue, number>> = { intro: 1, beginner: 2, intermediate: 3, advanced: 4 };
const COST_LEVEL: Readonly<Record<CostTierValue, number>> = { low: 1, medium: 2, high: 3 };
const PROVISION_ANGLE: Readonly<Record<ProvisionValue, number>> = { A: 30, B: 70, C: 110, D: 150 };

/** 指标名与短标签（纯函数，测试与表格视图共用）。 */
export function metricText(spec: MetricSpec, i18n: VisualI18n): { metric: string; value: string } {
  switch (spec.kind) {
    case 'difficulty':
      return { metric: i18n.t('visual.metric.difficulty'), value: i18n.t(`visual.metric.difficulty.${spec.value}` as VisualKey) };
    case 'duration':
      return { metric: i18n.t('visual.metric.duration'), value: i18n.minutes(spec.minutes) };
    case 'cost':
      return { metric: i18n.t('visual.metric.cost'), value: i18n.t(`visual.metric.cost.${spec.value}` as VisualKey) };
    case 'provision':
      return { metric: i18n.t('visual.metric.provision'), value: i18n.t(`visual.metric.provision.${spec.value}` as VisualKey) };
  }
}

function MetricGlyph({ spec }: { spec: MetricSpec }) {
  if (spec.kind === 'difficulty') {
    const n = DIFF_LEVEL[spec.value] ?? 1;
    return (
      <svg className="mi-ico" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        {[0, 1, 2, 3].map((i) => (
          <rect key={i} className={i < n ? 'on' : 'off'} x={1 + i * 3.75} y={12 - i * 3} width="2.6" height={3 + i * 3} rx=".6" />
        ))}
      </svg>
    );
  }
  if (spec.kind === 'duration') {
    return (
      <svg className="mi-ico line" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <circle cx="8" cy="8" r="6.2" />
        <path d="M8 4.5V8l2.6 1.6" />
      </svg>
    );
  }
  if (spec.kind === 'cost') {
    const n = COST_LEVEL[spec.value] ?? 1;
    return (
      <span className="mi-cost" aria-hidden="true">
        {[1, 2, 3].map((i) => (
          <span key={i} className={i <= n ? 'on' : 'off'}>
            $
          </span>
        ))}
      </span>
    );
  }
  const a = ((PROVISION_ANGLE[spec.value] ?? 90) * Math.PI) / 180;
  const x = Math.round((8 + 5 * Math.cos(a)) * 10) / 10;
  const y = Math.round((11 - 5 * Math.sin(a)) * 10) / 10;
  return (
    <svg className="mi-ico line" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false" data-provision={spec.value}>
      <path d="M1.8 11.5a6.2 6.2 0 0 1 12.4 0" />
      <path d={`M8 11L${x} ${y}`} />
      <circle className="fill" cx="8" cy="11" r="1.3" />
    </svg>
  );
}

export function MetricIcon({ compact, ...spec }: MetricIconProps) {
  const i18n = useVisualI18n();
  const { metric, value } = metricText(spec as MetricSpec, i18n);
  const full = i18n.t('visual.metric.aria', { metric, value });
  if (compact) {
    return (
      <span className="mi compact" role="img" aria-label={full} title={full} data-metric={spec.kind}>
        <MetricGlyph spec={spec as MetricSpec} />
      </span>
    );
  }
  return (
    <span className="mi" title={full} data-metric={spec.kind}>
      <MetricGlyph spec={spec as MetricSpec} />
      <span className="sr">{i18n.t('visual.metric.aria', { metric, value: '' })}</span>
      <span className="mi-text">{value}</span>
    </span>
  );
}

export interface MetricStripProps {
  difficulty?: DifficultyValue;
  minutes?: number;
  cost?: CostTierValue;
  provision?: ProvisionValue;
  compact?: boolean;
}

/** 卡片上的一行指标（难度 · 时长 · 费用 · 部署等级）。 */
export function MetricStrip({ difficulty, minutes, cost, provision, compact }: MetricStripProps) {
  return (
    <span className="mi-strip">
      {difficulty ? <MetricIcon kind="difficulty" value={difficulty} compact={compact} /> : null}
      {minutes != null ? <MetricIcon kind="duration" minutes={minutes} compact={compact} /> : null}
      {cost ? <MetricIcon kind="cost" value={cost} compact={compact} /> : null}
      {provision ? <MetricIcon kind="provision" value={provision} compact={compact} /> : null}
    </span>
  );
}
