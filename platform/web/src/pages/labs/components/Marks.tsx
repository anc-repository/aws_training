/**
 * 目录的小部件（05 §2.8、§2.10；08 §5.1）：类别几何符号、服务缩写方块、难度条、徽章图形 BadgeMark、进度环、分段进度条。
 * 全部平台自绘的内联 SVG（不使用 AWS 官方图标与配色，05 §2.10、08 §6.9）；颜色由 catalog.css 的类决定，不写 style 属性
 * （CSP style-src 'self'）；图形一律 aria-hidden 或 role="img" + 完整 aria-label（08 §8.4）。
 */
import { useId, type ReactElement } from 'react';
import { t } from '../../../i18n/zh-CN';
import { Shape, type StatusMeta } from '../../../ui';
import { catClass } from '../model';
import { BADGE_LEVEL_TEXT, DIFFICULTY_LEVEL, DIFFICULTY_TEXT, S } from '../strings';
import type { BadgeView, Difficulty } from '../types';

const CAT_SYMBOL: Readonly<Record<string, ReactElement>> = {
  base: <rect x="1" y="1" width="4" height="4" />,
  a: <path d="M3 .6L5.6 5.4H.4z" />,
  b: <path d="M3 .4L5.6 3 3 5.6.4 3z" />,
  c: <circle cx="3" cy="3" r="2.4" />,
  d: <path d="M1.6.6h2.8L5.8 3 4.4 5.4H1.6L.2 3z" />,
  e: <path d="M2.2.5h1.6v1.7h1.7v1.6H3.8v1.7H2.2V3.8H.5V2.2h1.7z" />,
  f: <path d="M.4 1.2h5.2v1.2H.4zM.4 3.6h5.2v1.2H.4z" />,
};

/** 类别几何符号（基础 方块 · A 三角 · B 菱形 · C 圆 · D 六边形 · E 加号 · F 两条横线）：不依赖颜色也能区分类别。 */
export function CatSymbol({ category }: { category: string | null | undefined }) {
  const key = (category ?? 'base') === 'base' ? 'base' : (category ?? 'base').toLowerCase();
  return (
    <svg className="cs" viewBox="0 0 6 6" aria-hidden="true" focusable="false">
      <g className="cs-fill">{CAT_SYMBOL[key] ?? CAT_SYMBOL.base}</g>
    </svg>
  );
}

export interface ServiceAbbrProps {
  abbr: string;
  category: string | null | undefined;
  size?: 32 | 20;
  /** 选做目标对应的服务（虚线框）。 */
  optional?: boolean;
  /** 悬停显示的全称与类别。 */
  title?: string;
}

/** 服务缩写方块：`--surface-2` 底、左侧 3px 类别色条、左上角 6px 类别符号；本身 aria-hidden，全称写在旁边的视觉隐藏文字中。 */
export function ServiceAbbr({ abbr, category, size = 32, optional, title }: ServiceAbbrProps) {
  const cls = ['sv', catClass(category), size === 20 ? 's20' : '', optional ? 'opt' : ''].filter(Boolean).join(' ');
  return (
    <span className={cls} title={title} aria-hidden="true">
      <CatSymbol category={category} />
      {abbr}
    </span>
  );
}

/** 难度：四段条 + 文字（形状加文字，不只靠颜色）。 */
export function DifficultyBar({ value }: { value: Difficulty }) {
  const n = DIFFICULTY_LEVEL[value] ?? 1;
  return (
    <span className="diff-wrap">
      <span className="diff" aria-hidden="true">
        {[1, 2, 3, 4].map((i) => (
          <i key={i} className={i <= n ? undefined : 'off'} />
        ))}
      </span>{' '}
      {DIFFICULTY_TEXT[value] ?? value}
    </span>
  );
}

export type BadgeState = 'none' | 'verified' | 'attested' | 'self-reported' | 'pending' | 'withdrawn';

/** 徽章的显示状态：未获得 / 等级 / 核验中 / 已撤回（tracks-and-catalog §5.2、§5.6）。 */
export function badgeStateOf(b: BadgeView | null | undefined): BadgeState {
  if (!b) return 'none';
  if (b.status === 'withdrawn') return 'withdrawn';
  if (b.status === 'pending') return 'pending';
  if (b.level === 'attested') return 'attested';
  if (b.level === 'self-reported') return 'self-reported';
  return 'verified';
}

export function badgeStateText(s: BadgeState): string {
  if (s === 'none') return S.card.badgeNone;
  if (s === 'pending') return S.card.badgePending;
  if (s === 'withdrawn') return S.card.badgeWithdrawn;
  return BADGE_LEVEL_TEXT[s] ?? s;
}

export interface BadgeMarkProps {
  kind: 'service' | 'scenario';
  /** 方块内的缩写（单服务卡）或场景短名（≤ 4 字）。 */
  label: string;
  state: BadgeState;
  title: string;
  size?: 24 | 40;
  /** 旧版角标“旧”。 */
  old?: boolean;
}

/**
 * 徽章图形（05 §2.10）：单服务卡圆角方块、场景卡六边形；外环按等级——已核验实线、含手动虚线、自述为主点线；
 * 未获得为空心轮廓；核验中为旋转虚线（减少动效时静止，另有文字）；已撤回为斜线填充。图形 role="img" + 完整说明。
 */
export function BadgeMark({ kind, label, state, title, size = 24, old }: BadgeMarkProps) {
  const sc = kind === 'scenario';
  const dash = state === 'attested' ? '3 2' : state === 'self-reported' ? '1 2' : state === 'none' || state === 'pending' ? '2 2' : undefined;
  const fs = sc ? (size >= 40 ? 9 : 6) : size >= 40 ? 11 : 8;
  const aria = `徽章：${title}，${badgeStateText(state)}`;
  const shapeCls = `bm-shape s-${state}${state === 'pending' ? ' spin' : ''}`;
  const hatch = `bmh${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  return (
    <span className="badge" role="img" aria-label={aria} data-badge={state}>
      <svg width={size} height={size} viewBox="0 0 40 40" focusable="false" aria-hidden="true">
        {state === 'withdrawn' ? (
          <defs>
            <pattern id={hatch} width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width="2" height="4" className="bm-hatch" />
            </pattern>
          </defs>
        ) : null}
        {sc ? (
          <path d="M20 2l16 9v18l-16 9-16-9V11z" className={shapeCls} strokeWidth="2" strokeDasharray={dash} />
        ) : (
          <rect x="3" y="3" width="34" height="34" rx="5" className={shapeCls} strokeWidth="2" strokeDasharray={dash} />
        )}
        {state === 'withdrawn' ? sc ? <path d="M20 2l16 9v18l-16 9-16-9V11z" fill={`url(#${hatch})`} /> : <rect x="3" y="3" width="34" height="34" rx="5" fill={`url(#${hatch})`} /> : null}
        <text x="20" y={sc ? 23 : 24} textAnchor="middle" fontSize={fs} fontWeight="600" className={state === 'none' ? 'bm-text off' : 'bm-text'}>
          {label}
        </text>
        {old ? (
          <text x="36" y="9" textAnchor="end" fontSize="8" className="bm-text">
            旧
          </text>
        ) : null}
      </svg>
    </span>
  );
}

/** 进度环（服务格的掌握度分数；只用于进度环，等级文字另写）。 */
export function ProgressRing({ score }: { score: number }) {
  const r = 9;
  const c = 2 * Math.PI * r;
  const f = Math.max(0, Math.min(1, score / 100));
  return (
    <svg className="ring" width="24" height="24" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r={r} fill="none" className="ring-bg" strokeWidth="3" />
      <circle cx="12" cy="12" r={r} fill="none" className="ring-fg" strokeWidth="3" strokeDasharray={`${(c * f).toFixed(2)} ${c.toFixed(2)}`} transform="rotate(-90 12 12)" />
    </svg>
  );
}

export interface SegmentedProgressProps {
  verified: number;
  attested: number;
  inProgress: number;
  min: number;
}

/** 分段条：已核验（实心）、含手动（斜纹）、进行中（浅色），总长为最少完成卡片数（08 §3.4、§5.1 TrackProgressRow）。 */
export function SegmentedProgress({ verified, attested, inProgress, min }: SegmentedProgressProps) {
  const total = Math.max(1, min);
  const w = (n: number) => Math.max(0, Math.min(100, (n / total) * 100));
  const a = w(verified);
  const m = Math.min(100 - a, w(attested));
  const p = Math.min(100 - a - m, w(inProgress));
  const label = t(S.track.segLabel, { a: verified, m: attested, p: inProgress, min });
  const hatch = `sgh${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  return (
    <svg className="segbar-svg" viewBox="0 0 100 8" preserveAspectRatio="none" role="img" aria-label={label} focusable="false">
      <defs>
        <pattern id={hatch} width="3" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="1.5" height="8" className="seg-m-stripe" />
        </pattern>
      </defs>
      <rect x="0" y="0" width="100" height="8" className="seg-bg" />
      {a > 0 ? <rect x="0" y="0" width={a} height="8" className="seg-a" /> : null}
      {m > 0 ? <rect x={a} y="0" width={m} height="8" className="seg-m" /> : null}
      {m > 0 ? <rect x={a} y="0" width={m} height="8" fill={`url(#${hatch})`} /> : null}
      {p > 0 ? <rect x={a + m} y="0" width={p} height="8" className="seg-p" /> : null}
    </svg>
  );
}

/** 状态文字（形状 + 文字 + 颜色）；`text` 为空时只画形状并把文字放进视觉隐藏区。 */
export function StateText({ meta, hideText, className }: { meta: StatusMeta; hideText?: boolean; className?: string }) {
  return (
    <span className={['st', meta.tone, className].filter(Boolean).join(' ')} data-status={meta.text}>
      <Shape name={meta.shape} spin={meta.spin} />
      {hideText ? <span className="sr">{meta.text}</span> : <span className="t">{meta.text}</span>}
    </span>
  );
}
