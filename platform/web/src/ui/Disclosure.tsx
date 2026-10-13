/**
 * Disclosure 浮层（08 §3.4、§8.3“浮层”；ui-design §8.2 Disclosure）：会话菜单、账号菜单、进度、步骤下拉、粘贴方式、`⋯` 菜单共用。
 * - 触发按钮 aria-expanded + aria-controls；点击展开，不在悬停时展开；
 * - 展开时焦点移到浮层内第一个链接或按钮；`focusContainer` 时落在浮层容器本身（账号菜单：避免一次回车就显示完整账号 ID）；
 * - Esc 或点击外部收起；Esc 收起时若焦点在浮层内，焦点回到触发按钮，不掉回 body。
 *
 * `useDisclosure` 供需要自定义触发区的组件使用（例如会话胶囊：链接 + 独立的 ▾ 按钮）。
 */
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';

export interface UseDisclosureOptions {
  focusContainer?: boolean;
}

export function useDisclosure(opts: UseDisclosureOptions = {}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<HTMLDivElement>(null);
  const { focusContainer } = opts;

  const close = useCallback((returnFocus = false) => {
    const inside = panelRef.current?.contains(document.activeElement) ?? false;
    setOpen(false);
    if (returnFocus || inside) buttonRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    const p = panelRef.current;
    if (p) {
      const target = focusContainer ? p : p.querySelector<HTMLElement>('a[href],button:not([disabled]),input:not([disabled])');
      target?.focus();
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close(true);
      }
    };
    const onDown = (e: MouseEvent) => {
      if (anchorRef.current && !anchorRef.current.contains(e.target as Node)) close(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [open, focusContainer, close]);

  return {
    open,
    close,
    anchorRef,
    buttonProps: {
      ref: buttonRef,
      type: 'button' as const,
      'aria-expanded': open,
      'aria-controls': id,
      onClick: () => setOpen((v) => !v),
    },
    panelProps: {
      ref: panelRef,
      id,
      hidden: !open,
      tabIndex: focusContainer ? -1 : undefined,
    },
  };
}

export interface DisclosureProps {
  /** 触发按钮内容。 */
  label: ReactNode;
  /** 触发按钮的 aria-label（内容只有图标或需要完整说明时）。 */
  ariaLabel?: string;
  buttonClassName?: string;
  /** 浮层内容；可以是函数，拿到 close() 用于菜单项点击后收起。 */
  children: ReactNode | ((close: () => void) => ReactNode);
  align?: 'right' | 'left';
  focusContainer?: boolean;
  /** 浮层容器的 role 与名称（账号菜单：role="group" aria-label="账号与区域"）。 */
  panelRole?: string;
  panelLabel?: string;
  className?: string;
}

export function Disclosure({
  label,
  ariaLabel,
  buttonClassName = 'btn sm',
  children,
  align = 'right',
  focusContainer,
  panelRole,
  panelLabel,
  className,
}: DisclosureProps) {
  const d = useDisclosure({ focusContainer });
  return (
    <div className={['pop-anchor', className].filter(Boolean).join(' ')} ref={d.anchorRef}>
      <button {...d.buttonProps} className={buttonClassName} aria-label={ariaLabel}>
        {label}
      </button>
      <div {...d.panelProps} className={align === 'left' ? 'popover left' : 'popover'} role={panelRole} aria-label={panelLabel}>
        {d.open ? (typeof children === 'function' ? children(() => d.close(true)) : children) : null}
      </div>
    </div>
  );
}
