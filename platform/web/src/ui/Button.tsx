/**
 * 按钮（原型 `.btn` 系列）。08 §1.3 原则 5：暂时不能做的置灰并用 aria-describedby 关联原因文字；
 * §4.0 局部加载：处理中保留宽度，文字改为“正在…”，aria-busy="true"。
 * 置灰用 aria-disabled（仍可聚焦、可读到原因），点击被吞掉；真正不可用（例如表单未就绪）才用 disabled。
 */
import { forwardRef, useId, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Icon, type IconName } from './Icon';

import { msg } from '../i18n';
export type ButtonVariant = 'default' | 'primary' | 'accent' | 'ghost' | 'danger' | 'danger-solid';

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  variant?: ButtonVariant;
  size?: 'sm' | 'md';
  icon?: IconName;
  /** 只有图标的按钮必须给 aria-label。 */
  iconOnly?: boolean;
  /** 处理中：显示 busyText（默认“正在处理…”），aria-busy。 */
  busy?: boolean;
  busyText?: string;
  /** 置灰原因：渲染为按钮后的说明文字，并用 aria-describedby 关联（原因节点总是渲染）。 */
  disabledReason?: string | null;
  children?: ReactNode;
}

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  default: '',
  primary: 'primary',
  accent: 'accent',
  ghost: 'ghost',
  danger: 'danger',
  'danger-solid': 'danger solid',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'default', size = 'md', icon, iconOnly, busy, busyText, disabledReason, className, onClick, type, children, ...rest },
  ref,
) {
  const reasonId = useId();
  const blocked = !!disabledReason || !!busy;
  const cls = ['btn', VARIANT_CLASS[variant], size === 'sm' ? 'sm' : '', iconOnly ? 'icon' : '', busy ? 'busy' : '', className]
    .filter(Boolean)
    .join(' ');
  const describedBy = [rest['aria-describedby'], disabledReason ? reasonId : null].filter(Boolean).join(' ') || undefined;
  const button = (
    <button
      ref={ref}
      type={type ?? 'button'}
      className={cls}
      {...rest}
      aria-disabled={blocked || rest['aria-disabled'] ? true : undefined}
      aria-busy={busy ? true : undefined}
      aria-describedby={describedBy}
      onClick={(e) => {
        if (blocked) {
          e.preventDefault();
          return;
        }
        onClick?.(e);
      }}
    >
      {icon ? <Icon name={icon} /> : null}
      {busy ? (busyText ?? msg.ui.button.busy) : children}
    </button>
  );
  if (!disabledReason) return button;
  return (
    <>
      {button}
      <span id={reasonId} className="small muted" data-reason="">
        {disabledReason}
      </span>
    </>
  );
});
