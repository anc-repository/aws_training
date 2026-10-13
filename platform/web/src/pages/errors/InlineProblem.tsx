/**
 * 画面内的错误呈现（08 P13；§4.0“错误 / 权限不足 / 会话状态不允许”）：
 * - 限速（#4）：“操作太频繁，请在 n 秒后重试。”逐秒倒计时，结束后回调 onReady（按钮恢复）；
 * - AWS 限流（#3）、版本冲突（#19）、状态冲突、阻止类：行内 note，不弹窗；
 * - 角色不足（#7）：原位置一句话；
 * - 其余（#2、#34）：区块级 ErrorPanel（title、说明、requestId、重试、复制诊断信息）。
 */
import { useEffect, useRef, useState } from 'react';
import type { ApiError } from '../../api/errors';
import { useAuth } from '../../app/context';
import { t, zhCN } from '../../i18n/zh-CN';
import { Button, ErrorPanel, Shape } from '../../ui';
import { describeProblem } from './problems';

export interface InlineProblemProps {
  error: ApiError | null | undefined;
  onRetry?: () => void;
  /** 限速倒计时结束。 */
  onReady?: () => void;
  overrides?: Record<string, string>;
  /** 区块标题（区块级错误）。 */
  title?: string;
}

export function useRetryCountdown(seconds: number | null, onDone?: () => void): number | null {
  const [left, setLeft] = useState<number | null>(seconds);
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    setLeft(seconds);
    if (seconds === null) return undefined;
    const started = Date.now();
    const id = setInterval(() => {
      const rest = Math.max(0, seconds - Math.floor((Date.now() - started) / 1000));
      setLeft(rest);
      if (rest <= 0) {
        clearInterval(id);
        done.current?.();
      }
    }, 1000);
    return () => clearInterval(id);
  }, [seconds]);
  return left;
}

export function InlineProblem({ error, onRetry, onReady, overrides, title }: InlineProblemProps) {
  const auth = useAuth();
  const p = describeProblem(error, { role: auth.principal?.role ?? null, overrides });
  const left = useRetryCountdown(p?.kind === 'rate-limited' ? p.retryAfterSec : null, onReady);
  if (!p || !error) return null;
  if (p.kind === 'rate-limited') {
    return (
      <p className="small" role="status" data-problem="rate-limited">
        {left && left > 0 ? t(zhCN.p13.rateLimited, { n: left }) : '可以重试了。'}
      </p>
    );
  }
  if (p.kind === 'unavailable' || p.kind === 'unknown' || p.kind === 'network') {
    return <ErrorPanel error={error} onRetry={onRetry} overrides={overrides} title={title} />;
  }
  return (
    <div className={`note ${p.tone}`} role={p.tone === 'red' ? 'alert' : 'status'} data-problem={p.kind}>
      <Shape name={p.tone === 'blue' ? 'dot' : p.tone === 'grey' ? 'ring' : 'tri'} />
      <span className="spacer">{p.message}</span>
      {p.retry && onRetry ? (
        <Button size="sm" onClick={onRetry} icon="refresh">
          {zhCN.app.retry}
        </Button>
      ) : null}
    </div>
  );
}
