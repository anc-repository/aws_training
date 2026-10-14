/**
 * 骨架屏（08 §4.0）：形状与真实布局一致，1.2 秒透明度呼吸，不用闪光；超过 10 秒仍未完成时出现“仍在加载… [重试]”。
 */
import { useEffect, useState } from 'react';
import { msg } from '../i18n';

export interface SkeletonProps {
  lines?: number;
  block?: boolean;
  /** 超时后显示的重试（不传则不显示重试按钮）。 */
  onRetry?: () => void;
  slowAfterMs?: number;
  label?: string;
}

export function Skeleton({ lines = 3, block, onRetry, slowAfterMs = 10_000, label = msg.app.loading }: SkeletonProps) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), slowAfterMs);
    return () => clearTimeout(timer);
  }, [slowAfterMs]);
  return (
    <div className="stack-8" aria-busy="true" aria-label={label} role="status">
      {block ? <div className="skel block" /> : null}
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className="skel" data-skel="" />
      ))}
      {slow ? (
        <div className="row small muted">
          {msg.app.stillLoading}
          {onRetry ? (
            <button type="button" className="btn sm" onClick={onRetry}>
              {msg.app.retry}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
