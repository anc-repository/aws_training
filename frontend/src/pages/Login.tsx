// 登录（F1）：local 与 cognito 两种 provider（总纲 12.2）。
//   - auth.driver=local：内置表单（含 MFA 第二步），登录页徽章“本地账号（EC2）”；https.trusted=false 时显示“当前连接未加密”横幅（SEC-005）；
//   - auth.driver=cognito：sdk 子模式仍是本站表单（BFF 代调 Cognito）；managed 子模式跳转托管登录页，内置表单路由重定向到这里。
// 同文件还有找回密码（/forgot）与重置密码（/reset）。
import { useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { describeError } from '../api/client';
import { useAuth } from '../auth/context';
import { authPublic, passwordProblems } from '../auth/config';
import { ModuleBadge } from '../capabilities/ModuleBadge';
import { useCaps } from '../capabilities/useCapability';

function safeNext(raw: string | null): string {
  return raw && raw.startsWith('/') && !raw.startsWith('//') ? raw : '/';
}

export function InsecureBanner() {
  const caps = useCaps();
  if (caps.https.trusted || caps.modules.auth?.driver !== 'local') return null;
  return (
    <p className="notice notice-warn" role="note">
      <strong>当前连接未加密</strong>：密码将以明文经网络传输（SEC-005）。启用 cdn、tls 或 Let's Encrypt 后可获得受信 HTTPS。
    </p>
  );
}

export function LoginPage() {
  const auth = useAuth();
  const caps = useCaps();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'));
  const [email, setEmail] = useState(params.get('email') ?? '');
  const [password, setPassword] = useState('');
  const [challenge, setChallenge] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(params.get('notice'));
  const [busy, setBusy] = useState(false);
  const pub = authPublic(caps);

  if (auth.user && !auth.user.restricted) return <Navigate to={next} replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await auth.login(email.trim(), password);
      if (r.kind === 'mfa') {
        setChallenge(r.challengeId);
        setInfo('请输入身份验证器中的 6 位动态码');
      } else if (r.kind === 'reset-required') {
        navigate(`/reset?email=${encodeURIComponent(email.trim())}&migrated=1`);
      } else {
        navigate(next, { replace: true });
      }
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const submitMfa = async (e: FormEvent) => {
    e.preventDefault();
    if (!challenge) return;
    setBusy(true);
    setError(null);
    try {
      await auth.completeMfa(challenge, code.trim());
      navigate(next, { replace: true });
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card panel-narrow">
      <div className="row spread" style={{ marginBottom: 8 }}>
        <h1 style={{ margin: 0 }}>登录</h1>
        <ModuleBadge module="auth" plain always />
      </div>
      <InsecureBanner />
      {info && <p className="notice">{info}</p>}
      {auth.mode === 'managed' ? (
        <div className="stack">
          <p className="muted">本站使用 Amazon Cognito 托管登录页（授权码 + PKCE，由服务端换取令牌并写入 HttpOnly Cookie）。</p>
          <button type="button" className="btn btn-primary" onClick={() => auth.startHostedLogin?.()}>前往托管登录页</button>
          <span className="subtle">托管登录 · {pub.hostedUiDomain ?? 'Cognito 域名'}</span>
        </div>
      ) : challenge ? (
        <form onSubmit={(e) => void submitMfa(e)}>
          <div className="field">
            <label htmlFor="mfa-code">动态码</label>
            <input id="mfa-code" className="input mono" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} required autoFocus />
          </div>
          {error && <p className="form-error" role="alert">{error}</p>}
          <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? '验证中…' : '验证'}</button>
        </form>
      ) : (
        <form onSubmit={(e) => void submit(e)}>
          <div className="field">
            <label htmlFor="login-email">邮箱</label>
            <input id="login-email" className="input" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </div>
          <div className="field">
            <label htmlFor="login-password">密码</label>
            <input id="login-password" className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </div>
          {error && <p className="form-error" role="alert">{error}</p>}
          <div className="row spread">
            <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? '登录中…' : '登录'}</button>
            <Link to="/forgot">忘记密码</Link>
          </div>
          {auth.mode === 'amplify' && <p className="subtle" style={{ marginTop: 8 }}>Amplify 变体：浏览器直接与 Cognito User Pool 交互（lab 选读）。</p>}
        </form>
      )}
      <p className="subtle" style={{ marginTop: 16 }}>还没有账号？<Link to="/register">注册</Link></p>
    </div>
  );
}

export function ForgotPage() {
  const auth = useAuth();
  const caps = useCaps();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (auth.mode === 'managed') return <Navigate to="/login?notice=托管登录模式下请在 Cognito 托管登录页找回密码" replace />;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await auth.forgot(email.trim());
      navigate(`/reset?email=${encodeURIComponent(email.trim())}`);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card panel-narrow">
      <h1>找回密码</h1>
      <p className="muted">
        我们会把验证码发到你的邮箱{caps.modules.email?.driver === 'outbox' ? '（本站未启用真实邮件：重置邮件写入本地 outbox，请联系管理员在 /admin/outbox 查看）' : ''}。
      </p>
      <form onSubmit={(e) => void submit(e)}>
        <div className="field">
          <label htmlFor="forgot-email">邮箱</label>
          <input id="forgot-email" className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </div>
        {error && <p className="form-error" role="alert">{error}</p>}
        <button type="submit" className="btn btn-primary" disabled={busy}>发送验证码</button>
      </form>
    </div>
  );
}

export function ResetPage() {
  const auth = useAuth();
  const caps = useCaps();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [email, setEmail] = useState(params.get('email') ?? '');
  const [code, setCode] = useState(params.get('code') ?? params.get('token') ?? '');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const policy = authPublic(caps).passwordPolicy;
  const problems = password ? passwordProblems(password, policy) : [];
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (problems.length) return;
    setError(null);
    try {
      await auth.reset(email.trim(), code.trim(), password);
      navigate(`/login?email=${encodeURIComponent(email.trim())}&notice=${encodeURIComponent('密码已重置，请用新密码登录')}`);
    } catch (err) {
      setError(describeError(err));
    }
  };
  return (
    <div className="card panel-narrow">
      <h1>设置新密码</h1>
      {params.get('migrated') && <p className="notice">账号已迁移到 Amazon Cognito，请用邮件中的验证码设置新密码。</p>}
      <form onSubmit={(e) => void submit(e)}>
        <div className="field"><label htmlFor="reset-email">邮箱</label><input id="reset-email" className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></div>
        <div className="field"><label htmlFor="reset-code">验证码</label><input id="reset-code" className="input mono" value={code} onChange={(e) => setCode(e.target.value)} required /></div>
        <div className="field">
          <label htmlFor="reset-password">新密码</label>
          <input id="reset-password" className="input" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          {problems.length > 0 && <span className="subtle">{problems.join('；')}</span>}
        </div>
        {error && <p className="form-error" role="alert">{error}</p>}
        <button type="submit" className="btn btn-primary" disabled={problems.length > 0}>保存新密码</button>
      </form>
    </div>
  );
}
