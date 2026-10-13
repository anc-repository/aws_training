/**
 * 分隔条与布局（03 §2.6、§2.8；08 P05.10）。纯函数 + localStorage（`atl.ws.layout.v1`，只存布局偏好，读写包在 try/catch 中）。
 *
 * - 默认左 40% / 右 60%（≥ 1600px 左 36%；1024～1279px 左 42%、左栏最小 300px）；
 * - 最小宽度左 320px、右 480px；拖到最小以下 48px 吸附为折叠（留 32px 竖条与展开按钮）；
 * - `aria-valuemin` / `aria-valuemax` 按当前容器宽度把 320px、480px 换算成百分比（不写 0 / 100）；
 * - ←/→ 16px、Shift+←/→ 64px、Home/End 跳到最小 / 最大宽度（不折叠）、只有 Enter 折叠；双击或 ⌃. 0 复位。
 */
import { lsGet, lsSet } from '../../lib/storage';

export const LAYOUT_KEY = 'atl.ws.layout.v1';
export const HANDLE_PX = 8;
export const COLLAPSED_PX = 32;
export const SNAP_PX = 48;

export interface LayoutPref {
  /** 左栏宽度百分比；null = 按断点取默认值。 */
  split: number | null;
  collapsed: boolean;
}

export function loadLayout(): LayoutPref {
  const v = lsGet<unknown>(LAYOUT_KEY, null);
  if (typeof v === 'number') return { split: clampPct(v), collapsed: false };
  if (v && typeof v === 'object') {
    const o = v as { split?: unknown; collapsed?: unknown };
    return { split: typeof o.split === 'number' ? clampPct(o.split) : null, collapsed: o.collapsed === true };
  }
  return { split: null, collapsed: false };
}

export function saveLayout(p: LayoutPref): void {
  lsSet(LAYOUT_KEY, p);
}

function clampPct(n: number): number {
  return Math.min(90, Math.max(10, n));
}

export function minLeftPx(width: number): number {
  return width < 1280 ? 300 : 320;
}

export const MIN_RIGHT_PX = 480;

export function defaultSplitPct(width: number): number {
  if (width >= 1600) return 36;
  if (width < 1280) return 42;
  return 40;
}

export interface SplitBounds {
  minPct: number;
  maxPct: number;
}

/** 以百分比表示的左栏最小 / 最大宽度（容器过窄时 min ≤ max 仍成立）。 */
export function splitBounds(width: number): SplitBounds {
  if (width <= 0) return { minPct: 25, maxPct: 75 };
  const usable = width - HANDLE_PX;
  const minPct = (minLeftPx(width) / usable) * 100;
  const maxPct = ((usable - MIN_RIGHT_PX) / usable) * 100;
  return { minPct: Math.min(minPct, maxPct), maxPct: Math.max(minPct, maxPct) };
}

export function clampSplit(pct: number, width: number): number {
  const b = splitBounds(width);
  return Math.min(b.maxPct, Math.max(b.minPct, pct));
}

/** 拖动结束（或拖动中）的左栏像素 → {pct, collapsed}：比最小宽度小 48px 以上时吸附为折叠。 */
export function dragTo(leftPx: number, width: number): { pct: number; collapsed: boolean } {
  const usable = Math.max(1, width - HANDLE_PX);
  if (leftPx < minLeftPx(width) - SNAP_PX) return { pct: splitBounds(width).minPct, collapsed: true };
  return { pct: clampSplit((leftPx / usable) * 100, width), collapsed: false };
}

export type SplitKey = 'ArrowLeft' | 'ArrowRight' | 'Home' | 'End' | 'Enter';

/** 键盘操作：返回新的百分比与折叠状态；不处理的键返回 null。 */
export function keyStep(key: string, shift: boolean, cur: { pct: number; collapsed: boolean }, width: number): { pct: number; collapsed: boolean } | null {
  const usable = Math.max(1, width - HANDLE_PX);
  const stepPct = ((shift ? 64 : 16) / usable) * 100;
  const b = splitBounds(width);
  switch (key) {
    case 'ArrowLeft':
      return { pct: clampSplit(cur.pct - stepPct, width), collapsed: false };
    case 'ArrowRight':
      return { pct: clampSplit(cur.pct + stepPct, width), collapsed: false };
    case 'Home':
      return { pct: b.minPct, collapsed: false };
    case 'End':
      return { pct: b.maxPct, collapsed: false };
    case 'Enter':
      return { pct: cur.pct, collapsed: !cur.collapsed };
    default:
      return null;
  }
}

/** 断点（03 §2.8）：wide ≥ 1280、mid 1024～1279、seg 768～1023（分段切换）、narrow < 768。 */
export type Breakpoint = 'wide' | 'mid' | 'seg' | 'narrow';

export function breakpointOf(width: number): Breakpoint {
  if (width >= 1280) return 'wide';
  if (width >= 1024) return 'mid';
  if (width >= 768) return 'seg';
  return 'narrow';
}

export function isSegmented(bp: Breakpoint): boolean {
  return bp === 'seg' || bp === 'narrow';
}
