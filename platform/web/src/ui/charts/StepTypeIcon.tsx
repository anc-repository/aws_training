/**
 * 步骤类型图标（I6 e）：控制台 / CLI / 脚本 / 代码 / 观察 / 对比实验（lab.schema.json $defs.step.type）。
 * 与 ui/Icon.tsx 同一套线性风格：20 × 20 网格、描边 1.6、currentColor、圆头；装饰时 aria-hidden，label 时 role="img"。
 */
import type { ReactElement } from 'react';
import { useVisualI18n, type VisualKey } from '../glyphs/visualI18n';
import './charts.css';

export type StepType = 'console' | 'cli' | 'script' | 'code' | 'observe' | 'experiment';
export const STEP_TYPES: readonly StepType[] = ['console', 'cli', 'script', 'code', 'observe', 'experiment'];

const STEP_PATHS: Readonly<Record<StepType, ReactElement>> = {
  console: (
    <>
      <rect x="2.5" y="3.5" width="15" height="11" rx="1.2" />
      <path d="M2.5 6.5h15" />
      <path className="fill" d="M10.5 9.5l6 2.3-2.6 1-1 2.7z" />
    </>
  ),
  cli: (
    <>
      <rect x="2.5" y="4" width="15" height="12" rx="1.2" />
      <path d="M5.5 8l2.5 2-2.5 2M10 12.5h4" />
    </>
  ),
  script: (
    <>
      <path d="M5 2.5h7l3 3v12H5z" />
      <path d="M12 2.5v3h3" />
      <path className="fill" d="M8.5 9v5.5l4.3-2.75z" />
    </>
  ),
  code: <path d="M6.5 6l-4 4 4 4M13.5 6l4 4-4 4M11.2 4.5l-2.4 11" />,
  observe: (
    <>
      <path d="M2 10s3-5 8-5 8 5 8 5-3 5-8 5-8-5-8-5z" />
      <circle cx="10" cy="10" r="2.2" />
    </>
  ),
  experiment: (
    <>
      <path d="M7.5 2.5h5M8.5 2.5v5.2L3.9 15.4a1.3 1.3 0 0 0 1.1 2h10a1.3 1.3 0 0 0 1.1-2l-4.6-7.7V2.5" />
      <path d="M5.8 12.5h8.4" />
    </>
  ),
};

const FALLBACK = <circle cx="10" cy="10" r="3" />;

export function isStepType(v: unknown): v is StepType {
  return typeof v === 'string' && (STEP_TYPES as readonly string[]).includes(v);
}

export interface StepTypeIconProps {
  type: string;
  size?: 16 | 20 | 24;
  /** role="img" + 类型名（单独出现、旁边没有文字时）。 */
  label?: boolean;
}

export function StepTypeIcon({ type, size = 16, label }: StepTypeIconProps) {
  const { t } = useVisualI18n();
  const known = isStepType(type);
  const a11y = label && known ? { role: 'img', 'aria-label': t(`visual.step.${type}` as VisualKey) } : { 'aria-hidden': true as const };
  return (
    <svg className="step-ico" width={size} height={size} viewBox="0 0 20 20" focusable="false" data-step-type={type} {...a11y}>
      {known ? STEP_PATHS[type] : FALLBACK}
    </svg>
  );
}

/** 图标 + 短标签（手册步骤标题旁、步骤列表）。 */
export function StepTypeTag({ type }: { type: string }) {
  const { t } = useVisualI18n();
  return (
    <span className="step-tag" data-step-type={type}>
      <StepTypeIcon type={type} />
      <span>{isStepType(type) ? t(`visual.step.${type}` as VisualKey) : type}</span>
    </span>
  );
}
