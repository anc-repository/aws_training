/**
 * 结果类画面（报告、回收进度、证书、我的实验、对比实验）共用的图形（I6 f；09「视觉化」）：用图形代替大段文字。
 *
 * - 颜色只按语义色调（`Tone`，取自 src/ui/semantics.ts 的映射）经 `.vtone.<tone>` 类决定，不写 style 属性（CSP style-src 'self'）；
 * - 这些图形都是“已有文字的图形化”：默认 aria-hidden，含义由旁边的文字或 role="img" 的标签表达（08 §8.4），
 *   不重复输出已有的句子（测试与读屏都按原文查找）；
 * - 只用 tokens.css 已有的 token；亮、暗两套主题与 forced-colors 下都可读；窄屏不横向溢出（SVG 按容器宽度伸缩）。
 */
import type { ReactNode } from 'react';
import { Icon, Shape, type IconName, type ShapeName } from '../../ui';
import type { Tone } from '../../ui/semantics';

/** 一组图块（KPI 方块）：图形 + 数值 + 短标签。 */
export function VTiles({ children, label, decorative }: { children: ReactNode; label?: string; /** 同样的内容另有文字（读屏读那段文字）。 */ decorative?: boolean }) {
  return (
    <div className="vtiles" role={label && !decorative ? 'group' : undefined} aria-label={decorative ? undefined : label} aria-hidden={decorative || undefined}>
      {children}
    </div>
  );
}

export function VTile({ visual, value, label, data }: { visual: ReactNode; value?: ReactNode; label: ReactNode; data?: string }) {
  return (
    <div className="vtile" data-tile={data}>
      <span className="vtile-vis">{visual}</span>
      <span className="vtile-txt">
        {value !== undefined && value !== null ? <span className="vtile-v">{value}</span> : null}
        <span className="vtile-k">{label}</span>
      </span>
    </div>
  );
}

/** 圆形徽记：状态形状放大（色调决定颜色，填充 = 已到达的状态）。 */
export function StatusBadge({ shape, tone, size = 'md' }: { shape: ShapeName; tone: Tone; size?: 'sm' | 'md' | 'lg' }) {
  return (
    <span className={`vbadge vtone ${tone} ${size}`} aria-hidden="true">
      <Shape name={shape} />
    </span>
  );
}

/** 圆形图标（时钟、回收、文档…）。 */
export function IconBadge({ name, tone = 'mut', filled, size = 'md' }: { name: IconName; tone?: Tone; filled?: boolean; size?: 'sm' | 'md' | 'lg' }) {
  return (
    <span className={`vicon vtone ${tone} ${size}${filled ? ' fill' : ''}`} aria-hidden="true">
      <Icon name={name} large />
    </span>
  );
}

export interface StripItem {
  key: string;
  n: number;
  tone: Tone;
  /** 实心：已经有结论（通过、失败、需人工…）；空心：还没有。 */
  filled: boolean;
  /** 悬停提示。 */
  tip: string;
}

/** 步骤条：每步一个带序号的圆点，颜色 = 步骤状态的色调（装饰；逐步的文字在下方列表中）。 */
export function StepStrip({ items }: { items: readonly StripItem[] }) {
  if (!items.length) return null;
  return (
    <ol className="vstrip" aria-hidden="true">
      {items.map((s) => (
        <li key={s.key} className={`vtone ${s.tone}${s.filled ? ' fill' : ''}`} title={s.tip}>
          <span>{s.n}</span>
        </li>
      ))}
    </ol>
  );
}

export interface StackSeg {
  key: string;
  value: number;
  tone: Tone;
  /** 悬停提示（“已删除: 3”）。 */
  label: string;
}

/** 堆叠条：各状态的数量占比（装饰；数量的文字在旁边）。 */
export function StackBar({ segments, total }: { segments: readonly StackSeg[]; total?: number }) {
  const sum = total ?? segments.reduce((a, s) => a + Math.max(0, s.value), 0);
  let x = 0;
  return (
    <svg className="vstack" viewBox="0 0 100 8" preserveAspectRatio="none" aria-hidden="true" focusable="false">
      <rect className="vstack-track" x="0" y="0" width="100" height="8" />
      {sum > 0
        ? segments
            .filter((s) => s.value > 0)
            .map((s) => {
              const w = Math.round((s.value / sum) * 1000) / 10;
              const r = (
                <rect key={s.key} className={`vtone ${s.tone}`} x={x} y="0" width={w} height="8" data-seg={s.key}>
                  <title>{`${s.label}: ${s.value}`}</title>
                </rect>
              );
              x = Math.round((x + w) * 10) / 10;
              return r;
            })
        : null}
    </svg>
  );
}

/** 迷你进度条（完成 / 总数；装饰）。 */
export function MiniBar({ done, total, tone = 'pass' }: { done: number; total: number; tone?: Tone }) {
  const w = total > 0 ? Math.round(Math.max(0, Math.min(1, done / total)) * 1000) / 10 : 0;
  return (
    <svg className="vmini" viewBox="0 0 100 6" preserveAspectRatio="none" aria-hidden="true" focusable="false">
      <rect className="vstack-track" x="0" y="0" width="100" height="6" />
      {w > 0 ? <rect className={`vtone ${tone}`} x="0" y="0" width={w} height="6" /> : null}
    </svg>
  );
}

/** 比例条 + 门槛刻度（例如“已核验”占比与要求的最低值；装饰，数值文字在旁边）。 */
export function RatioMeter({ value, min }: { value: number | null | undefined; min: number }) {
  const v = typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : null;
  const m = Math.max(0, Math.min(1, min));
  const ok = v !== null && v >= m;
  return (
    <svg className="vmeter" viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden="true" focusable="false" data-ok={ok ? '1' : '0'}>
      <rect className="vstack-track" x="0" y="2" width="100" height="6" />
      {v !== null && v > 0 ? <rect className={`vtone ${ok ? 'pass' : 'mut'}`} x="0" y="2" width={Math.round(v * 1000) / 10} height="6" /> : null}
      <line className="vmeter-tick" x1={m * 100} x2={m * 100} y1="0" y2="10" />
    </svg>
  );
}

/** 16 角的徽记外缘（证书的“印章”）。 */
const ROSETTE = (() => {
  const pts: string[] = [];
  for (let i = 0; i < 32; i++) {
    const a = (Math.PI * 2 * i) / 32 - Math.PI / 2;
    const r = i % 2 === 0 ? 18.5 : 15.6;
    pts.push(`${(20 + r * Math.cos(a)).toFixed(2)} ${(20 + r * Math.sin(a)).toFixed(2)}`);
  }
  return `M${pts.join('L')}Z`;
})();

export type SealMark = 'check' | 'x' | 'star' | 'dash' | 'none';

const SEAL_MARK: Readonly<Record<SealMark, ReactNode>> = {
  check: <path d="M14.2 20.4l3.9 3.8 7.7-8.3" />,
  x: <path d="M15.5 15.5l9 9M24.5 15.5l-9 9" />,
  star: <path className="f" d="M20 13.6l1.9 4 4.4.5-3.3 3 .9 4.4L20 23.3l-3.9 2.2.9-4.4-3.3-3 4.4-.5z" />,
  dash: <path d="M15 20h10" />,
  none: null,
};

/**
 * 证书徽记（自绘的玫瑰形印章，不使用 AWS 认证徽章造型，05 §2.10）：外缘与圆心按色调着色；`hollow` = 还没有（空心轮廓）。
 * 装饰图形：状态的文字在旁边。
 */
export function CertSeal({ tone, mark, hollow, size = 40, className }: { tone: Tone; mark: SealMark; hollow?: boolean; size?: number; className?: string }) {
  return (
    <svg
      className={`vseal vtone ${tone}${hollow ? ' hollow' : ''}${className ? ` ${className}` : ''}`}
      width={size}
      height={size}
      viewBox="0 0 40 40"
      aria-hidden="true"
      focusable="false"
      data-seal={mark}
    >
      <path className="vseal-out" d={ROSETTE} />
      <circle className="vseal-in" cx="20" cy="20" r="11" />
      <g className="vseal-mark">{SEAL_MARK[mark]}</g>
    </svg>
  );
}

export interface TimelineMark {
  key: string;
  at: number;
  label: string;
  tone?: Tone;
}

/** 时间轴：起点到终点的横线，各时间点的刻度与短标签（装饰；对应的文字在旁边的列表中）。 */
export function TimeBar({ from, to, now, marks }: { from: number; to: number; now?: number | null; marks: readonly TimelineMark[] }) {
  const span = to - from;
  if (!(span > 0)) return null;
  const pos = (t: number) => Math.round(Math.max(0, Math.min(1, (t - from) / span)) * 1000) / 10;
  const p = now != null ? pos(now) : null;
  return (
    <div className="vtime" aria-hidden="true">
      <svg viewBox="0 0 100 10" preserveAspectRatio="none" focusable="false">
        <rect className="vstack-track" x="0" y="3" width="100" height="4" />
        {p !== null && p > 0 ? <rect className="vtone kept" x="0" y="3" width={p} height="4" /> : null}
        {marks.map((m) => (
          <line key={m.key} className={`vtime-tick vtone ${m.tone ?? 'mut'}`} x1={pos(m.at)} x2={pos(m.at)} y1="0" y2="10" />
        ))}
      </svg>
      <ol className="vtime-labels">
        {marks.map((m) => (
          <li key={m.key} className={`vtone ${m.tone ?? 'mut'}`} data-pos={pos(m.at) > 66 ? 'end' : pos(m.at) > 33 ? 'mid' : 'start'}>
            <span className="vtime-k">{m.label}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** 已有结论的色调用实心（步骤条、阶段图示共用）。 */
export function isSettledTone(tone: Tone): boolean {
  return tone !== 'mut' && tone !== 'faint' && tone !== 'lock' && tone !== 'pend';
}
