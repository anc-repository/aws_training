/**
 * P01 登录（08 §4 P01）：`/login?next=<原路径>&reason=<expired|signed-out|reauth|signed-out-elsewhere>`。
 * - 生产：按钮跳转 Cognito 托管登录（授权码 + PKCE）；账号密码、MFA、找回密码都在托管登录页完成，SPA 不接触密码；
 * - 本地开发（config.json `auth: "dev"`，只在本机地址）：开发身份表单，生成 dev-server 认可的开发令牌。
 * 已登录（且不是“需要重新登录”）时直接回到 next。
 */
import { useState, type FormEvent, type ReactNode } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import type { CognitoGroup } from '@atl/shared';
import { useAuth, useServices } from '../../app/context';
import { safeNext } from '../../auth/authService';
import { zhCN } from '../../i18n/zh-CN';
import { BrandMark, Button, Field } from '../../ui';

const REASON_TEXT: Record<string, string> = {
  expired: zhCN.auth.reasonExpired,
  reauth: zhCN.auth.reasonReauth,
  'signed-out-elsewhere': zhCN.auth.reasonSignedOutElsewhere,
};

export function LoginCard({ children }: { children: ReactNode }) {
  return (
    <div className="login pubcard">
      <div className="row between">
        <span className="brand">
          <BrandMark />
          <span>{zhCN.app.name}</span>
        </span>
        <span className="tag">{zhCN.app.unofficial}</span>
      </div>
      {children}
    </div>
  );
}

function DevLoginForm({ next }: { next: string }) {
  const { auth } = useServices();
  const navigate = useNavigate();
  const [group, setGroup] = useState<CognitoGroup>('learner');
  const [sub, setSub] = useState('u1');
  const [stale, setStale] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const a = zhCN.auth;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(sub)) {
      setError('只能包含字母、数字、- 与 _（1～64 个字符）');
      return;
    }
    if (auth.devLogin(group, sub, { staleAuth: stale })) navigate(next, { replace: true });
  };
  return (
    <form className="stack" onSubmit={submit} data-dev-login="">
      <h2>{a.devTitle}</h2>
      <p className="small muted">{a.devHint}</p>
      <Field label={a.devGroup}>
        <select className="input" value={group} onChange={(e) => setGroup(e.target.value as CognitoGroup)}>
          <option value="learner">learner（{zhCN.roles.L}）</option>
          <option value="assistant">assistant（{zhCN.roles.A}）</option>
          <option value="observer">observer（{zhCN.roles.O}）</option>
        </select>
      </Field>
      <Field label={a.devSub} error={error}>
        <input className="input mono" value={sub} onChange={(e) => setSub(e.target.value)} autoComplete="off" spellCheck={false} />
      </Field>
      <label className="chk small">
        <input type="checkbox" checked={stale} onChange={(e) => setStale(e.target.checked)} />
        <span>{a.devStaleAuth}</span>
      </label>
      <div>
        <Button type="submit" variant="primary">
          {a.devSignIn}
        </Button>
      </div>
    </form>
  );
}

export default function LoginPage() {
  const { auth } = useServices();
  const snap = useAuth();
  const [search] = useSearchParams();
  const [busy, setBusy] = useState(false);
  const reason = search.get('reason');
  const next = safeNext(search.get('next'), '/');
  const a = zhCN.auth;
  // 使用中过期（P13 #5）或需要最近登录时停留在登录页
  if (snap.status === 'authenticated' && !snap.expired && reason !== 'reauth') return <Navigate to={next} replace />;
  return (
    <LoginCard>
      <h1 tabIndex={-1}>{a.loginTitle}</h1>
      <p>{a.tagline}</p>
      {reason && REASON_TEXT[reason] ? (
        <p className="note amber" role="status">
          {REASON_TEXT[reason]}
        </p>
      ) : null}
      {auth.mode === 'cognito' ? (
        <div>
          <Button
            variant="primary"
            busy={busy}
            busyText="正在跳转…"
            onClick={() => {
              setBusy(true);
              void auth.beginLogin(next).catch(() => setBusy(false));
            }}
          >
            {a.signIn}
          </Button>
        </div>
      ) : auth.mode === 'dev' ? (
        <DevLoginForm next={next} />
      ) : (
        <p className="note red">{a.configFailed}</p>
      )}
      <p className="small muted">{a.firstLogin}</p>
      <p className="small muted">{a.forgot}</p>
      <p className="small faint">ⓘ {a.tabOnly}</p>
    </LoginCard>
  );
}
