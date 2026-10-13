/**
 * 状态形状的 SVG 字符串（静态公开产物用；与 src/ui/Shape.tsx 的路径一致，08 §6.2、§6.9）。
 * 颜色取 currentColor；反色笔画用 `.inv` / `.invf` 类；一律 aria-hidden，含义由旁边的文字表达。
 */
import type { ShapeName } from '../../ui/Shape';

const P: Readonly<Record<ShapeName, string>> = {
  dot: '<circle cx="6" cy="6" r="4.5" fill="currentColor"/>',
  check: '<circle cx="6" cy="6" r="5" fill="currentColor"/><path class="inv" d="M3.6 6.2l1.7 1.6 3.2-3.4" stroke-width="1.4" fill="none"/>',
  ring: '<circle cx="6" cy="6" r="4.3" fill="none" stroke="currentColor" stroke-width="1.4"/>',
  clock: '<circle cx="6" cy="6" r="4.6" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M6 3.4V6l1.8 1.2" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>',
  tri: '<path d="M6 1.2l5 9.4H1z" fill="currentColor"/><path class="inv" d="M6 4.6v3" stroke-width="1.3"/><circle class="invf" cx="6" cy="9" r=".7"/>',
  sq: '<rect x="1.5" y="1.5" width="9" height="9" fill="currentColor"/>',
  hg: '<path d="M2.5 1.5h7M2.5 10.5h7M3.2 1.5c0 3 5.6 3 5.6 4.5S3.2 7.5 3.2 10.5M8.8 1.5c0 3-5.6 3-5.6 4.5s5.6 1.5 5.6 4.5" fill="none" stroke="currentColor" stroke-width="1.2"/>',
  dia: '<path d="M6 .8l5.2 5.2L6 11.2.8 6z" fill="currentColor"/>',
  xbox: '<rect x="1" y="1" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M3.5 3.5l5 5M8.5 3.5l-5 5" stroke="currentColor" stroke-width="1.3"/>',
  half: '<circle cx="6" cy="6" r="4.5" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M6 1.5a4.5 4.5 0 0 1 0 9z" fill="currentColor"/>',
  q1: '<circle cx="6" cy="6" r="4.5" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M6 6V1.5A4.5 4.5 0 0 1 10.5 6z" fill="currentColor"/>',
  q3: '<circle cx="6" cy="6" r="4.5" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M6 6V1.5A4.5 4.5 0 1 1 1.5 6z" fill="currentColor"/>',
  dash: '<path d="M2 6h8" stroke="currentColor" stroke-width="1.6"/>',
  q: '<circle cx="6" cy="6" r="4.8" fill="none" stroke="currentColor" stroke-width="1.2" stroke-dasharray="2 1.4"/><path d="M4.6 4.6a1.5 1.5 0 1 1 1.9 1.4c-.4.2-.5.4-.5.9" fill="none" stroke="currentColor" stroke-width="1.1"/><circle cx="6" cy="8.6" r=".6" fill="currentColor"/>',
  man: '<rect x="1" y="1" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.1" stroke-dasharray="2 1.3"/><path d="M3.6 8.4V3.8L6 6.6l2.4-2.8v4.6" fill="none" stroke="currentColor" stroke-width="1.1"/>',
  manp: '<rect x="1" y="1" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.1" stroke-dasharray="2 1.3"/><path d="M2.6 8.4V3.8L4.6 6.4l2-2.6v4.6" fill="none" stroke="currentColor" stroke-width="1.1"/><path d="M8.9 2.6v3M7.4 4.1h3" stroke="currentColor" stroke-width="1.3"/>',
  wrench: '<path d="M8.2 1.5a2.6 2.6 0 0 0-3 3.4L1.5 8.6l1.9 1.9 3.7-3.7A2.6 2.6 0 0 0 10.5 3.8L9.2 5.1 7.9 4.8l-.3-1.3z" fill="currentColor"/>',
  lock: '<rect x="2" y="5.5" width="8" height="5.5" rx=".8" fill="currentColor"/><path d="M3.8 5.5V4a2.2 2.2 0 0 1 4.4 0v1.5" fill="none" stroke="currentColor" stroke-width="1.2"/>',
  retry: '<path d="M10 6a4 4 0 1 1-1.2-2.8" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M9.6 1.4v2.4H7.2" fill="none" stroke="currentColor" stroke-width="1.3"/>',
  spin: '<circle cx="6" cy="6" r="4.4" fill="none" stroke="currentColor" stroke-opacity=".25" stroke-width="1.6"/><path d="M6 1.6a4.4 4.4 0 0 1 4.4 4.4" fill="none" stroke="currentColor" stroke-width="1.6"/>',
};

export function shapeSvgString(name: ShapeName): string {
  return `<svg class="shp" viewBox="0 0 12 12" aria-hidden="true" focusable="false">${P[name]}</svg>`;
}
