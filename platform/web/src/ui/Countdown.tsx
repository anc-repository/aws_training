/**
 * 倒计时 Countdown（08 §5.2、§6.4）。
 * - 剩余时间每次渲染都由 `deadlineAt - now()` 重新计算，不做递减（02 §5.5）；`now` 由调用方传入服务端时钟（serverClock.now）；
 * - 每秒刷新一次显示；页面不可见时不刷新，回到前台立即重算；
 * - role="timer"、aria-live="off"：读屏不逐秒播报（阈值播报由全局 LiveRegion 负责，见 components/useExpiryAnnouncements）；
 * - 紧急程度 U0～U4 的形状与底色见 semantics.urgencyOf；不闪烁（WCAG 2.3.1）。
 */
import { useEffect, useState } from 'react';
import { formatClock, formatCountdown, formatUtcTitle } from '../lib/format';
import { Shape } from './Shape';
import { keepUrgencyOf, URGENCY_META, urgencyOf } from './semantics';

import { msg, t } from '../i18n';
export interface CountdownProps {
  deadlineAt: string | null | undefined;
  now: () => number;
  variant?: 'inline' | 'bar' | 'keep';
  /** 离线时注明“按服务器时间计算”。 */
  offline?: boolean;
}

/** 每秒触发一次重渲染（页面隐藏时暂停）。 */
export function useSecondTick(active = true): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!active) return undefined;
    const id = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      setTick((x) => x + 1);
    }, 1000);
    const onVis = () => {
      if (!document.hidden) setTick((x) => x + 1);
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [active]);
  return tick;
}

export function Countdown({ deadlineAt, now, variant = 'inline', offline }: CountdownProps) {
  useSecondTick(!!deadlineAt);
  if (!deadlineAt) {
    return (
      <span className="cd-inline muted" role="timer" aria-live="off">
        {msg.ui.countdown.notStarted}
      </span>
    );
  }
  const deadline = Date.parse(deadlineAt);
  const remaining = deadline - now();
  if (variant === 'keep') {
    const k = keepUrgencyOf(remaining);
    return (
      <span className={`st ${k === 'K2' ? 'drift' : 'kept'}`} role="timer" aria-live="off" title={formatUtcTitle(deadline)} data-urgency={k}>
        <Shape name={k === 'K2' ? 'tri' : 'dia'} />
        <span className="t cd-inline">
          {t(msg.ui.countdown.keepUntil, { t: formatClock(deadline), left: formatCountdown(remaining) })}
        </span>
      </span>
    );
  }
  const u = urgencyOf(remaining);
  const meta = URGENCY_META[u];
  const text = u === 'U4' ? msg.ui.countdown.overdue : formatCountdown(remaining);
  if (variant === 'bar') {
    return (
      <span className="row" data-urgency={u}>
        <span className={`cdbig ${meta.cls}`} role="timer" aria-live="off">
          <Shape name={meta.shape} />
          {text}
        </span>
        {u !== 'U4' ? (
          <span className="small muted" title={formatUtcTitle(deadline)}>
            {t(msg.ui.countdown.expiresAt, { t: formatClock(deadline) })}
          </span>
        ) : null}
        {offline ? <span className="small faint">{msg.ui.countdown.serverTime}</span> : null}
      </span>
    );
  }
  return (
    <span className="cd-inline" role="timer" aria-live="off" data-urgency={u} title={formatUtcTitle(deadline)}>
      {text}
    </span>
  );
}
