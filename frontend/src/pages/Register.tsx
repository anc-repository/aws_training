// 注册（F1–F3）与邮箱验证（/verify）。
//   - local + email=outbox：注册后提示“验证邮件已写入本地 outbox：可在 /me/outbox 查看发给你的邮件（本地实现，未真正发信）”；
//   - cognito：验证邮件由 Amazon Cognito 发送；managed 子模式下内置注册表单重定向到登录页（托管登录页自带注册）。
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { describeError } from '../api/client';
import { useAuth } from '../auth/context';
import { authPublic, passwordProblems } from '../auth/config';
import { ModuleBadge } from '../capabilities/ModuleBadge';
import { useCaps } from '../capabilities/useCapability';
import { InsecureBanner } from './Login';

export function RegisterPage() {
  const auth = useAuth();
  const caps = useCaps();
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ needsConfirmation: boolean; restrictedSession?: boolean } | null>(null);
  const pub = authPublic(caps);
  const problems = password ? passwordProblems(password, pub.passwordPolicy) : [];
  const mismatch = password2 !== '' && password !== password2;

  if (auth.mode === 'managed') {
    return <Navigate to={`/login?notice=${encodeURIComponent('本站使用 Cognito 托管登录页，请在托管登录页注册')}`} replace />;
  }
  if (auth.user && !auth.user.restricted) return <Navigate to="/" replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (problems.length || mismatch) return;
    setBusy(true);
    setError(null);
    try {
      setDone(await auth.register({ email: email.trim(), password, displayName: displayName.trim() }));
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  if (done) return <RegisterDone email={email.trim()} result={done} />;

  return (
    <div className="card panel-narrow">
      <div className="row spread" style={{ marginBottom: 8 }}>
        <h1 style={{ margin: 0 }}>注册</h1>
        <ModuleBadge module="auth" plain always />
      </div>
      <InsecureBanner />
      <form onSubmit={(e) => void submit(e)}>
        <div className="field"><label htmlFor="reg-name">昵称</label><input id="reg-name" className="input" value={displayName} onChange={(e) => setDisplayName(e.target.value)} required maxLength={120} /></div>
        <div className="field"><label htmlFor="reg-email">邮箱</label><input id="reg-email" className="input" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></div>
        <div className="field">
          <label htmlFor="reg-password">密码</label>
          <input id="reg-password" className="input" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          <span className="subtle">
            至少 {pub.passwordPolicy.minLength} 位{pub.passwordPolicy.requireUpper ? '，含大写字母' : ''}{pub.passwordPolicy.requireDigit ? '，含数字' : ''}{pub.passwordPolicy.requireSymbol ? '，含符号' : ''}
            {problems.length > 0 ? `（还需要：${problems.join('；')}）` : ''}
          </span>
        </div>
        <div className="field">
          <label htmlFor="reg-password2">确认密码</label>
          <input id="reg-password2" className="input" type="password" autoComplete="new-password" value={password2} onChange={(e) => setPassword2(e.target.value)} required />
          {mismatch && <span className="form-error">两次输入不一致</span>}
        </div>
        {error && <p className="form-error" role="alert">{error}</p>}
        <button type="submit" className="btn btn-primary" disabled={busy || problems.length > 0 || mismatch}>{busy ? '注册中…' : '注册'}</button>
      </form>
      <p className="subtle" style={{ marginTop: 16 }}>已有账号？<Link to="/login">登录</Link></p>
    </div>
  );
}

function RegisterDone({ email, result }: { email: string; result: { needsConfirmation: boolean; restrictedSession?: boolean } }) {
  const caps = useCaps();
  const outbox = caps.modules.email?.driver === 'outbox';
  const cognito = caps.modules.auth?.driver === 'cognito';
  if (!result.needsConfirmation) {
    return (
      <div className="card panel-narrow">
        <h1>注册成功</h1>
        <Link className="btn btn-primary" to={`/login?email=${encodeURIComponent(email)}`}>去登录</Link>
      </div>
    );
  }
  return (
    <div className="card panel-narrow stack">
      <h1>请验证邮箱</h1>
      {cognito ? (
        <p>验证邮件由 Amazon Cognito 发送，请查收邮箱中的验证码。</p>
      ) : outbox ? (
        <p className="notice notice-warn">
          本站未启用真实邮件：验证邮件已写入本地 outbox。可在 <Link to="/me/outbox">/me/outbox</Link> 查看发给你的邮件（本地实现，未真正发信）
          {result.restrictedSession ? '。' : '，登录受限会话后可见；或请管理员在 /admin/outbox 代为查看。'}
        </p>
      ) : (
        <p>验证邮件已发送到 {email}，请查收。</p>
      )}
      <ConfirmForm email={email} />
    </div>
  );
}

function ConfirmForm({ email: initialEmail, code: initialCode = '', auto = false }: { email: string; code?: string; auto?: boolean }) {
  const auth = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState(initialEmail);
  const [code, setCode] = useState(initialCode);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const autoRan = useRef(false);

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await auth.confirm(email.trim(), code.trim());
      navigate(`/login?email=${encodeURIComponent(email.trim())}&notice=${encodeURIComponent('邮箱已验证，请登录')}`);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!auto || autoRan.current || !code) return;
    autoRan.current = true;
    void confirm();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在带参数打开验证链接时自动提交一次
  }, [auto, code]);

  const resend = async () => {
    setError(null);
    try {
      await auth.resend(email.trim());
      setInfo('已重新发送验证邮件');
    } catch (err) {
      setError(describeError(err));
    }
  };

  return (
    <form onSubmit={(e) => { e.preventDefault(); void confirm(); }}>
      <div className="field"><label htmlFor="cf-email">邮箱</label><input id="cf-email" className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></div>
      <div className="field"><label htmlFor="cf-code">验证码</label><input id="cf-code" className="input mono" value={code} onChange={(e) => setCode(e.target.value)} required autoComplete="one-time-code" /></div>
      {error && <p className="form-error" role="alert">{error}</p>}
      {info && <p className="form-ok">{info}</p>}
      <div className="row">
        <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? '验证中…' : '验证'}</button>
        <button type="button" className="btn" onClick={() => void resend()}>重新发送</button>
      </div>
    </form>
  );
}

/** 验证邮件中的链接：/verify?email=…&code=…（或 token=…），打开即自动提交 */
export function VerifyPage() {
  const [params] = useSearchParams();
  const email = params.get('email') ?? '';
  const code = params.get('code') ?? params.get('token') ?? '';
  return (
    <div className="card panel-narrow">
      <h1>验证邮箱</h1>
      <ConfirmForm email={email} code={code} auto={Boolean(code)} />
    </div>
  );
}
