/**
 * P01 授权码回调 `/auth/callback`（08 §4 P01）：校验 state、换取令牌、按 next 回跳；不渲染可交互内容（失败时除外）。
 * - 处理中：居中“正在完成登录…”（role="status"，转圈在减少动效时静止）；
 * - state 不匹配或缺失：“登录请求已失效（可能是打开了旧的登录页）。请重新登录。”[重新登录]；
 * - 回调带 error：“登录未完成：{error_description}”[重新登录]；换取令牌失败：“无法连接登录服务…”[重试]。
 */
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useServices } from '../../app/context';
import { msg, t } from '../../i18n';
import { Button, Shape } from '../../ui';
import { LoginCard } from './LoginPage';
import './login.css';

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
  const a = msg.auth;
  if (outcome.kind === 'working') {
    return (
      <LoginCard>
        <h1 tabIndex={-1} className="sr">
          {a.callbackWorking}
        </h1>
        <div className="row" role="status" data-callback="working">
          <Shape name="spin" spin />
          <span>{a.callbackWorking}</span>
        </div>
      </LoginCard>
    );
  }
  const text = outcome.kind === 'stale' ? a.callbackStale : outcome.kind === 'error' ? t(a.callbackError, { error: outcome.error }) : a.tokenFailed;
  return (
    <LoginCard>
      <h1 tabIndex={-1}>{msg.frame.login.callbackFailed}</h1>
      <div className="note red" role="alert" data-callback={outcome.kind}>
        <Shape name="xbox" />
        <span>{text}</span>
      </div>
      <div className="row">
        {outcome.kind === 'token-failed' ? (
          <Button variant="primary" onClick={() => window.location.reload()}>
            {msg.app.retry}
          </Button>
        ) : (
          <Link className="btn primary" to="/login">
            {msg.p13.signInAgain}
          </Link>
        )}
      </div>
    </LoginCard>
  );
}
