// <ModuleBadge module="cdn" outcome="hit" />：能力徽章（总纲 12.3）。
// 颜色只是辅助，徽章一定有文字；悬停显示状态与 detail；已登录用户点击进入 /lab/m/<id>（/lab 对登录用户只读开放）。
// 用户设置“显示架构徽章”关闭时不渲染（/lab 上的徽章传 always）。
import { Link } from 'react-router-dom';
import type { ModuleId } from '@cloudalbum/contracts';
import { useAuthOptional } from '../auth/context';
import { usePrefs } from '../prefs';
import { badgeFor, TONE_CLASS, type BadgeVars } from './badges';
import { useCapability, useRegistry } from './useCapability';

export interface ModuleBadgeProps {
  module: ModuleId;
  outcome?: string | undefined;
  variant?: string | undefined;
  vars?: BadgeVars | undefined;
  /** 忽略“显示架构徽章”偏好 */
  always?: boolean;
  /** 不渲染成链接 */
  plain?: boolean;
  className?: string;
}

export function ModuleBadge({ module, outcome, variant, vars, always = false, plain = false, className = '' }: ModuleBadgeProps) {
  const cap = useCapability(module);
  const registry = useRegistry();
  const prefs = usePrefs();
  const auth = useAuthOptional();
  if (!cap) return null;
  if (!always && !prefs.showBadges) return null;
  const { text, tone, title } = badgeFor(module, cap, registry, { outcome, variant, vars });
  const cls = `badge badge-${TONE_CLASS[tone]} ${className}`.trim();
  if (!plain && auth?.user) {
    return (
      <Link className={cls} to={`/lab/m/${module}`} title={title} data-module={module} data-tone={tone}>
        {text}
      </Link>
    );
  }
  return (
    <span className={cls} title={title} data-module={module} data-tone={tone}>
      {text}
    </span>
  );
}
