/**
 * 分隔条 Splitter（08 P05.10；03 §2.6）：视觉 1px、命中区 8px，悬停加深，拖动中 2px --accent；Pointer Events + setPointerCapture；
 * 拖动时给 iframe 覆盖透明遮罩（工作台根上的 data-ws-drag），终端在拖动结束后才重算尺寸（派发 atl:ws-drag-end）。
 * `role="separator"`、`aria-orientation="vertical"`、`aria-valuenow`，`aria-valuemin` / `aria-valuemax` 按当前容器宽度把 320px、480px
 * 换算成百分比（不写 0 / 100），`aria-valuetext`“手册宽度 40%”；←/→ 16px、Shift+←/→ 64px、Home/End 跳到最小 / 最大宽度（不折叠）、
 * 只有 Enter 折叠；双击或 ⌃. 0 复位。
 */
import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { dragTo, keyStep, splitBounds } from '../model/layout';

import { t } from '../../i18n';
import { W } from '../strings';
export interface SplitterProps {
  pct: number;
  collapsed: boolean;
  width: number;
  onChange: (next: { pct: number; collapsed: boolean }, commit: boolean) => void;
  onReset: () => void;
  container: () => HTMLElement | null;
}

export function Splitter({ pct, collapsed, width, onChange, onReset, container }: SplitterProps) {
  const [drag, setDrag] = useState(false);
  const start = useRef<{ left: number } | null>(null);
  const b = splitBounds(width);
  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const el = container();
    if (!el) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    start.current = { left: el.getBoundingClientRect().left };
    setDrag(true);
    document.documentElement.dataset.wsDrag = '1';
  };
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag || !start.current) return;
    onChange(dragTo(e.clientX - start.current.left, width), false);
  };
  const end = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag) return;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    setDrag(false);
    start.current = null;
    delete document.documentElement.dataset.wsDrag;
    onChange({ pct, collapsed }, true);
    window.dispatchEvent(new Event('atl:ws-drag-end'));
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const next = keyStep(e.key, e.shiftKey, { pct, collapsed }, width);
    if (!next) return;
    e.preventDefault();
    onChange(next, true);
    window.dispatchEvent(new Event('atl:ws-drag-end'));
  };
  const now = Math.round(collapsed ? b.minPct : pct);
  return (
    <div
      className={drag ? 'splitter drag' : 'splitter'}
      role="separator"
      aria-orientation="vertical"
      aria-controls="mpane"
      aria-label={W.splitter.label}
      aria-valuenow={now}
      aria-valuemin={Math.round(b.minPct)}
      aria-valuemax={Math.round(b.maxPct)}
      aria-valuetext={collapsed ? W.splitter.collapsed : t(W.splitter.width, { n: now })}
      tabIndex={0}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={onReset}
      onKeyDown={onKey}
      data-splitter=""
    />
  );
}
