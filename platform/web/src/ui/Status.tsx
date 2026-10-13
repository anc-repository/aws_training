/**
 * 状态文字（形状 + 文字 + 颜色，08 §6.2；原型 `st()`）与会话状态胶囊 `SessionStatePill`（§5.2，规则同 ui-design StatusBadge）。
 */
import type { SessionState } from '@atl/shared';
import { Shape } from './Shape';
import { SESSION_STATE_META, type DisplaySessionState, type StatusMeta } from './semantics';

export interface StatusProps {
  meta: StatusMeta;
  /** 只显示形状（文字放进视觉隐藏区，读屏仍能读到）。 */
  shapeOnly?: boolean;
  /** 附加文字（例如“·过期”后缀）。 */
  suffix?: string;
  className?: string;
}

export function Status({ meta, shapeOnly, suffix, className }: StatusProps) {
  const text = suffix ? `${meta.text}${suffix}` : meta.text;
  return (
    <span className={['st', meta.tone, className].filter(Boolean).join(' ')} data-status={meta.text}>
      <Shape name={meta.shape} spin={meta.spin} />
      {shapeOnly ? <span className="sr">{text}</span> : <span className="t">{text}</span>}
    </span>
  );
}

export interface SessionStatePillProps {
  state: SessionState | DisplaySessionState;
  size?: 'sm' | 'md';
  /** `sm` 只显示形状时带 aria-label（§5.2）。 */
  shapeOnly?: boolean;
}

export function SessionStatePill({ state, size = 'md', shapeOnly }: SessionStatePillProps) {
  const m = SESSION_STATE_META[state];
  const cls = ['pill', m.pill, size === 'sm' ? 'sm' : ''].filter(Boolean).join(' ');
  if (shapeOnly) {
    return (
      <span className={cls} role="img" aria-label={m.text} data-state={state}>
        <Shape name={m.shape} spin={m.spin} />
      </span>
    );
  }
  return (
    <span className={cls} data-state={state}>
      <Shape name={m.shape} spin={m.spin} />
      {m.text}
    </span>
  );
}
