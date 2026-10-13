/**
 * 通用 UI 图标（08 §6.9、D-UI-10）：平台自绘的 20×20 线性图标，以内联 SVG 实现，不引用 lucide-react 等外部图标库；
 * 取自原型的 `ICO` 表。描边 1.5～1.6px，currentColor；装饰性图标 aria-hidden（需要含义时由按钮的 aria-label 表达）。
 */
import type { ReactElement } from 'react';

export type IconName =
  | 'menu'
  | 'x'
  | 'chev'
  | 'right'
  | 'left'
  | 'ext'
  | 'copy'
  | 'term'
  | 'cloud'
  | 'eye'
  | 'search'
  | 'refresh'
  | 'split'
  | 'preview'
  | 'play'
  | 'bell'
  | 'gear'
  | 'user'
  | 'key'
  | 'doc'
  | 'clock'
  | 'dots'
  | 'pause'
  | 'shield'
  | 'down'
  | 'link'
  | 'paste'
  | 'wrench'
  | 'lock'
  | 'check'
  | 'plus';

const ICO: Readonly<Record<IconName, ReactElement>> = {
  menu: <path d="M3 5h14M3 10h14M3 15h14" />,
  x: <path d="M5 5l10 10M15 5L5 15" />,
  chev: <path d="M6 8l4 4 4-4" />,
  right: <path d="M8 5l5 5-5 5" />,
  left: <path d="M12 5l-5 5 5 5" />,
  ext: <path d="M11 4h5v5M16 4l-7 7M14 12v4H4V6h4" />,
  copy: (
    <>
      <rect x="7" y="7" width="9" height="9" rx="1" />
      <path d="M4 13V4h9" />
    </>
  ),
  term: (
    <>
      <rect x="2.5" y="4" width="15" height="12" rx="1" />
      <path d="M6 8l2.5 2L6 12M10 12h4" />
    </>
  ),
  cloud: <path d="M6 15h8.5a3 3 0 0 0 .3-6 4.5 4.5 0 0 0-8.6-1A3.5 3.5 0 0 0 6 15z" />,
  eye: (
    <>
      <path d="M2 10s3-5 8-5 8 5 8 5-3 5-8 5-8-5-8-5z" />
      <circle cx="10" cy="10" r="2" />
    </>
  ),
  search: (
    <>
      <circle cx="9" cy="9" r="5" />
      <path d="M13 13l4 4" />
    </>
  ),
  refresh: (
    <>
      <path d="M16 6v4h-4M4 14v-4h4" />
      <path d="M15.5 10A5.5 5.5 0 0 0 5.2 7.5M4.5 10a5.5 5.5 0 0 0 10.3 2.5" />
    </>
  ),
  split: (
    <>
      <rect x="3" y="3" width="14" height="14" rx="1" />
      <path d="M3 10h14" />
    </>
  ),
  preview: (
    <>
      <rect x="2.5" y="3.5" width="15" height="13" rx="1" />
      <path d="M2.5 7h15" />
    </>
  ),
  play: <path d="M7 5l8 5-8 5z" />,
  bell: <path d="M5 14V9a5 5 0 0 1 10 0v5l1.5 1.5h-13zM8.5 17.5h3" />,
  gear: (
    <>
      <circle cx="10" cy="10" r="2.5" />
      <path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M4.7 15.3l1.4-1.4M13.9 6.1l1.4-1.4" />
    </>
  ),
  user: (
    <>
      <circle cx="10" cy="7" r="3" />
      <path d="M4 17c1-3.5 3.5-5 6-5s5 1.5 6 5" />
    </>
  ),
  key: (
    <>
      <circle cx="7" cy="10" r="3" />
      <path d="M10 10h7M14 10v3M16.5 10v2" />
    </>
  ),
  doc: (
    <>
      <path d="M5 2.5h7l3 3v12H5z" />
      <path d="M12 2.5v3h3M7.5 9h5M7.5 12h5M7.5 15h3" />
    </>
  ),
  clock: (
    <>
      <circle cx="10" cy="10" r="7" />
      <path d="M10 6v4l3 2" />
    </>
  ),
  dots: (
    <>
      <circle cx="5" cy="10" r=".8" />
      <circle cx="10" cy="10" r=".8" />
      <circle cx="15" cy="10" r=".8" />
    </>
  ),
  pause: <path d="M7 5v10M13 5v10" />,
  shield: <path d="M10 2.5l6 2.5v5c0 4-3 6.5-6 7.5-3-1-6-3.5-6-7.5V5z" />,
  down: <path d="M10 3v10M6 9l4 4 4-4M4 17h12" />,
  link: <path d="M8.5 11.5l3-3M7 9.5L5 11.5a2.5 2.5 0 0 0 3.5 3.5l2-2M13 10.5l2-2A2.5 2.5 0 0 0 11.5 5l-2 2" />,
  paste: (
    <>
      <rect x="5" y="4" width="10" height="13" rx="1" />
      <path d="M8 4V2.5h4V4M8 9h4M8 12h4" />
    </>
  ),
  wrench: <path d="M12.5 3a4 4 0 0 0-4.6 5.3L3 13.2 4.8 15l4.9-4.9A4 4 0 0 0 15 5.5l-2 2-2-.5-.5-2z" />,
  lock: (
    <>
      <rect x="4.5" y="9" width="11" height="8" rx="1" />
      <path d="M7 9V6.5a3 3 0 0 1 6 0V9" />
    </>
  ),
  check: <path d="M4 10.5l4 4 8-9" />,
  plus: <path d="M10 4v12M4 10h12" />,
};

export interface IconProps {
  name: IconName;
  /** 20px 版本（默认 16px）。 */
  large?: boolean;
}

export function Icon({ name, large }: IconProps) {
  return (
    <svg className={large ? 'ico lg' : 'ico'} viewBox="0 0 20 20" aria-hidden="true" focusable="false" data-icon={name}>
      {ICO[name]}
    </svg>
  );
}

/** 平台标志（顶栏、登录页）。 */
export function BrandMark() {
  return (
    <svg className="mark" viewBox="0 0 22 22" aria-hidden="true" focusable="false">
      <rect className="mark-bg" x="1" y="1" width="20" height="20" rx="3" />
      <path className="mark-fg" d="M5.5 8l3 3-3 3" fill="none" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path className="mark-ac" d="M11 14.5h5.5" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
