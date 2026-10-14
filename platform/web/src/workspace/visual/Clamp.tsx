/**
 * 长说明默认折叠（09 I6 e“超过 3 行的说明默认折叠”）：段落用 CSS 行截断显示前 3 行，下方“詳しく / Details / 展开全文”按钮展开。
 *
 * - 只有文字较长（CLAMP_MIN_CHARS 以上）的段落才包一层，短段落照常输出 `<p>`，不做测量；
 * - 布局后测量：实际不超过 3 行（宽屏、译文较短）时不显示按钮（截断类对 ≤ 3 行的文字没有效果）；容器宽度变化时重新测量；
 * - 截断只是视觉效果：全文一直在 DOM 中，读屏与页内搜索都能读到；按钮带 aria-expanded / aria-controls；
 * - 不写 style 属性（CSP style-src 'self'），行数由 `.clamp3` 类决定。
 */
import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

import { W } from '../strings';

/** 少于这么多字符的段落不折叠（手册栏约 30～70 字符一行，3 行至少 90 字符）。 */
export const CLAMP_MIN_CHARS = 90;

export function Clamp({ children, className }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const id = `cl${useId().replace(/:/g, '')}`;
  const [open, setOpen] = useState(false);
  const [fits, setFits] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || open) return;
    const measure = () => {
      // 没有布局（隐藏的面板、测试环境）时不判断，保留按钮
      if (!el.clientHeight) return;
      setFits(el.scrollHeight <= el.clientHeight + 1);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [open]);
  return (
    <div className={className ? `clamp ${className}` : 'clamp'} data-clamp={open ? 'open' : 'closed'}>
      <p ref={ref} id={id} className={open ? undefined : 'clamp3'}>
        {children}
      </p>
      {fits && !open ? null : (
        <button type="button" className="clamp-btn" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)}>
          {open ? W.md.less : W.md.more}
        </button>
      )}
    </div>
  );
}
