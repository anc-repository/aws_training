/**
 * P01 授权码回调 `/auth/callback`：校验 state、换取令牌、按 next 回跳；不渲染可交互内容（失败时除外）。
 */
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useServices } from '../../app/context';
import { t, zhCN } from '../../i18n/zh-CN';
import { Button, Skeleton } from '../../ui';
import { LoginCard } from './LoginPage';

type Outcome = { kind: 'working' } | { kind: 'stale' } | { kind: 'error'; error: string } | { kind: 'token-failed' };

export default function AuthCallbackPage() {
  const { auth } = useServices();
  const navigate = useNavigate();
  const [outcome, setOutcome] = useState<Outcome>({ kind: 'working' });
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const params = new URLSearchParams(window.location.search);
    void auth.completeLogin(params).then((r) => {
      if (r.result === 'ok') navigate(r.next, { replace: true });
      else if (r.result === 'error') setOutcome({ kind: 'error', error: r.error });
      else setOutcome({ kind: r.result });
    });
  }, [auth, navigate]);
  const a = zhCN.auth;
  if (outcome.kind === 'working') {
    return (
      <LoginCard>
        <h1 tabIndex={-1}>{a.callbackWorking}</h1>
        <Skeleton lines={1} label={a.callbackWorking} />
      </LoginCard>
    );
  }
  const text = outcome.kind === 'stale' ? a.callbackStale : outcome.kind === 'error' ? t(a.callbackError, { error: outcome.error }) : a.tokenFailed;
  return (
    <LoginCard>
      <h1 tabIndex={-1}>{a.loginTitle}</h1>
      <p className="note red" role="alert">
        {text}
      </p>
      <div className="row">
        {outcome.kind === 'token-failed' ? (
          <Button variant="primary" onClick={() => window.location.reload()}>
            {zhCN.app.retry}
          </Button>
        ) : (
          <Link className="btn primary" to="/login">
            {zhCN.p13.signInAgain}
          </Link>
        )}
      </div>
    </LoginCard>
  );
}
