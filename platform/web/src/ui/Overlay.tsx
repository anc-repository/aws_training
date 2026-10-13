/**
 * 对话框 Dialog 与抽屉 Drawer（08 §5.5“沿用 ui-design Drawer/Dialog”、§8.3 键盘、§8.4）。
 *
 * - 焦点锁定；打开时焦点落在 `initialFocus`（选择器）→ 带 data-autofocus 的元素 → 正文第一个可交互元素 → 页脚按钮 → 标题；
 *   危险操作的确认按钮不是默认焦点（调用方把 initialFocus 指向“取消”）。
 * - Esc 关闭；关闭后焦点回到触发元素（已被重绘替换时回到 `returnFocusTo()` 给出的元素，再退回页面 h1），不掉回 body。
 * - 打开期间应用根节点（#root）设为 inert；`alert` 变体为 role="alertdialog"（到期 / 结束覆盖层等）。
 * - 不使用 alert / confirm / prompt（§8.3）。窄屏全屏由 CSS 处理。
 */
import { useEffect, useId, useRef, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { zhCN } from '../i18n/zh-CN';
import { Icon } from './Icon';

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),summary,[tabindex]:not([tabindex="-1"])';

function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => !el.closest('[inert]') && !el.hasAttribute('hidden'));
}

let inertCount = 0;
function setAppInert(on: boolean): void {
  const root = typeof document !== 'undefined' ? document.getElementById('root') : null;
  inertCount = Math.max(0, inertCount + (on ? 1 : -1));
  if (!root) return;
  if (inertCount > 0) root.setAttribute('inert', '');
  else root.removeAttribute('inert');
}

export interface FocusTrapOptions {
  initialFocus?: string;
  returnFocusTo?: () => HTMLElement | null;
  onEscape?: () => void;
}

/** 焦点锁定 + Esc + 关闭后焦点回位。 */
export function useFocusTrap(ref: RefObject<HTMLElement | null>, active: boolean, opts: FocusTrapOptions): void {
  const optsRef = useRef(opts);
  optsRef.current = opts;
  useEffect(() => {
    if (!active) return undefined;
    const root = ref.current;
    if (!root) return undefined;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const pick = (): HTMLElement | null => {
      const o = optsRef.current;
      if (o.initialFocus) {
        const el = root.querySelector<HTMLElement>(o.initialFocus);
        if (el) return el;
      }
      const auto = root.querySelector<HTMLElement>('[data-autofocus]');
      if (auto) return auto;
      const body = root.querySelector<HTMLElement>('[data-overlay-body]');
      const inBody = body ? focusables(body)[0] : undefined;
      if (inBody) return inBody;
      const foot = root.querySelector<HTMLElement>('[data-overlay-footer]');
      const inFoot = foot ? focusables(foot)[0] : undefined;
      return inFoot ?? root.querySelector<HTMLElement>('[data-overlay-title]') ?? root;
    };
    pick()?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (optsRef.current.onEscape) {
          e.stopPropagation();
          optsRef.current.onEscape();
        }
        return;
      }
      if (e.key !== 'Tab') return;
      const list = focusables(root);
      if (!list.length) {
        e.preventDefault();
        return;
      }
      const first = list[0]!;
      const last = list[list.length - 1]!;
      const cur = document.activeElement;
      if (e.shiftKey && (cur === first || !root.contains(cur))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (cur === last || !root.contains(cur))) {
        e.preventDefault();
        first.focus();
      }
    };
    root.addEventListener('keydown', onKey);
    return () => {
      root.removeEventListener('keydown', onKey);
      // 根节点的 inert 在同一次提交的清理中才解除：在微任务里再判断触发元素是否还可用
      queueMicrotask(() => {
        const back =
          trigger && trigger.isConnected && !trigger.closest('[inert]') && !(trigger as HTMLButtonElement).disabled
            ? trigger
            : (optsRef.current.returnFocusTo?.() ?? document.querySelector<HTMLElement>('main h1, h1'));
        back?.focus();
      });
    };
  }, [active, ref]);
}

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  /** 页脚左侧的说明文字。 */
  footerLead?: ReactNode;
  size?: 'narrow' | 'default' | 'wide';
  /** role="alertdialog"（到期、结束等需要立即注意的确认）。 */
  alert?: boolean;
  initialFocus?: string;
  returnFocusTo?: () => HTMLElement | null;
  /** 为 false 时 Esc 与关闭按钮不可用（例如提交中）。 */
  dismissible?: boolean;
  describedBy?: string;
}

export function Dialog({
  open,
  onClose,
  title,
  children,
  footer,
  footerLead,
  size = 'default',
  alert,
  initialFocus,
  returnFocusTo,
  dismissible = true,
  describedBy,
}: DialogProps) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useFocusTrap(ref, open, { initialFocus, returnFocusTo, onEscape: dismissible ? onClose : undefined });
  useEffect(() => {
    if (!open) return undefined;
    setAppInert(true);
    return () => setAppInert(false);
  }, [open]);
  if (!open) return null;
  return createPortal(
    <div className="scrim" data-overlay="dialog">
      <div
        ref={ref}
        className={['dlg', size === 'default' ? '' : size].filter(Boolean).join(' ')}
        role={alert ? 'alertdialog' : 'dialog'}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={describedBy}
      >
        <header>
          <h2 id={titleId} tabIndex={-1} data-overlay-title="">
            {title}
          </h2>
          {dismissible ? (
            <button type="button" className="btn sm ghost icon" aria-label={zhCN.app.close} onClick={onClose}>
              <Icon name="x" />
            </button>
          ) : null}
        </header>
        <div className="dbody" data-overlay-body="">
          {children}
        </div>
        {footer || footerLead ? (
          <footer data-overlay-footer="">
            {footerLead ? <span className="lead">{footerLead}</span> : null}
            {footer}
          </footer>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children?: ReactNode;
  wide?: boolean;
  initialFocus?: string;
  returnFocusTo?: () => HTMLElement | null;
}

/** 右侧抽屉（560px / 720px，窄屏全屏）；点击遮罩或 Esc 关闭。抽屉的开关由调用方写进查询串（§2.5）。 */
export function Drawer({ open, onClose, title, children, wide, initialFocus, returnFocusTo }: DrawerProps) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useFocusTrap(ref, open, { initialFocus, returnFocusTo, onEscape: onClose });
  useEffect(() => {
    if (!open) return undefined;
    setAppInert(true);
    return () => setAppInert(false);
  }, [open]);
  if (!open) return null;
  return createPortal(
    <>
      <div className="drawer-scrim" data-overlay="drawer-scrim" onClick={onClose} />
      <div ref={ref} className={wide ? 'drawer w720' : 'drawer'} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header>
          <h2 id={titleId} tabIndex={-1} data-overlay-title="">
            {title}
          </h2>
          <button type="button" className="btn sm ghost icon" aria-label={zhCN.app.close} onClick={onClose}>
            <Icon name="x" />
          </button>
        </header>
        <div className="dbody" data-overlay-body="">
          {children}
        </div>
      </div>
    </>,
    document.body,
  );
}
