// auth=cognito（本文件只经动态 import() 加载：L0 的首屏包里没有任何 Cognito / Amplify 代码，总纲 12.1 第 2 条）。
//
// 子模式（capabilities.modules.auth.public.loginMode）：
//   - sdk（默认）：仍是本站表单，经 BFF 由后端调用 Cognito（SignUp / InitiateAuth …），令牌只在 HttpOnly Cookie 中；
//   - managed：登录按钮跳转 /api/auth/login（BFF 发起授权码 + PKCE，回到 /api/auth/callback）；内置表单路由重定向到登录页；
//   - amplify（lab 选读变体）：动态 import('aws-amplify/auth')，浏览器直接与 User Pool 交互，令牌经 Authorization: Bearer
//     发给 API。需要一个“不带密钥”的公开 App Client（auth.public.publicClientId）——BFF 客户端带密钥，浏览器不能用。
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { setBearerTokenProvider } from '../api/client';
import { setIdTokenProvider } from '../upload/identityPoolUpload';
import { authApi } from '../api/endpoints';
import type { Me } from '../api/types';
import { useCapabilities, useCaps } from '../capabilities/useCapability';
import { authMode, authPublic, type AuthPublic } from './config';
import { AuthContext, isAdminUser, type AuthContextValue, type LoginOutcome } from './context';
import { useBffAuth } from './useBffAuth';

export default function CognitoAuthProvider({ children }: { children: ReactNode }) {
  const caps = useCaps();
  const pub = authPublic(caps);
  const mode = authMode(pub);
  return mode === 'amplify'
    ? <AmplifyAuth pub={pub}>{children}</AmplifyAuth>
    : <BffCognitoAuth mode={mode}>{children}</BffCognitoAuth>;
}

function BffCognitoAuth({ mode, children }: { mode: 'embedded' | 'managed'; children: ReactNode }) {
  const value = useBffAuth('cognito', mode);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

// ------------------------------------------------------------------------------------------ Amplify 变体
type AmplifyAuthModule = typeof import('aws-amplify/auth');

let amplifyLoading: Promise<AmplifyAuthModule> | null = null;

/** 动态加载 aws-amplify 并配置 User Pool（只在 Amplify 变体下调用） */
export function loadAmplify(pub: AuthPublic): Promise<AmplifyAuthModule> {
  amplifyLoading ??= (async () => {
    const clientId = pub.publicClientId ?? pub.userPoolClientId;
    if (!pub.userPoolId || !clientId) {
      throw new Error('Amplify 变体需要 auth.public.userPoolId 与不带密钥的 publicClientId');
    }
    const [{ Amplify }, auth] = await Promise.all([import('aws-amplify'), import('aws-amplify/auth')]);
    Amplify.configure({ Auth: { Cognito: { userPoolId: pub.userPoolId, userPoolClientId: clientId } } });
    return auth;
  })();
  amplifyLoading.catch(() => {
    amplifyLoading = null;
  });
  return amplifyLoading;
}

function AmplifyAuth({ pub, children }: { pub: AuthPublic; children: ReactNode }) {
  const { refresh: refreshCaps } = useCapabilities();
  const [user, setUser] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    try {
      const auth = await loadAmplify(pub);
      const session = await auth.fetchAuthSession();
      if (!session.tokens?.accessToken) {
        setBearerTokenProvider(null);
        setIdTokenProvider(null);
        setUser(null);
        return;
      }
      setBearerTokenProvider(async () => (await auth.fetchAuthSession()).tokens?.accessToken?.toString() ?? null);
      // identity-pool=cognito：/api/uploads/credentials 需要 ID 令牌（Amplify 子模式下它不在 Cookie 里）
      setIdTokenProvider(async () => (await auth.fetchAuthSession()).tokens?.idToken?.toString() ?? null);
      setUser(await authApi.me());
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, [pub]);

  useEffect(() => {
    void reload();
    return () => {
      setBearerTokenProvider(null);
      setIdTokenProvider(null);
    };
  }, [reload]);

  const afterSignIn = useCallback(async () => {
    await reload();
    void refreshCaps();
  }, [reload, refreshCaps]);

  const login = useCallback(async (email: string, password: string): Promise<LoginOutcome> => {
    const auth = await loadAmplify(pub);
    const r = await auth.signIn({ username: email, password });
    const step = r.nextStep.signInStep;
    if (step === 'CONFIRM_SIGN_IN_WITH_TOTP_CODE') return { kind: 'mfa', challengeId: 'amplify' };
    if (step === 'RESET_PASSWORD') return { kind: 'reset-required', message: '请用邮件中的验证码设置新密码' };
    if (step !== 'DONE') throw new Error(`Cognito 要求额外步骤：${step}`);
    await afterSignIn();
    return { kind: 'ok' };
  }, [pub, afterSignIn]);

  const value = useMemo<AuthContextValue>(() => ({
    provider: 'cognito',
    mode: 'amplify',
    user,
    loading,
    isAdmin: isAdminUser(user),
    login,
    completeMfa: async (_challengeId, code) => {
      const auth = await loadAmplify(pub);
      await auth.confirmSignIn({ challengeResponse: code });
      await afterSignIn();
    },
    register: async ({ email, password, displayName }) => {
      const auth = await loadAmplify(pub);
      const r = await auth.signUp({ username: email, password, options: { userAttributes: { email, name: displayName } } });
      return { needsConfirmation: r.nextStep.signUpStep === 'CONFIRM_SIGN_UP' };
    },
    confirm: async (email, code) => {
      const auth = await loadAmplify(pub);
      await auth.confirmSignUp({ username: email, confirmationCode: code });
    },
    resend: async (email) => {
      const auth = await loadAmplify(pub);
      await auth.resendSignUpCode({ username: email });
    },
    forgot: async (email) => {
      const auth = await loadAmplify(pub);
      await auth.resetPassword({ username: email });
    },
    reset: async (email, code, newPassword) => {
      const auth = await loadAmplify(pub);
      await auth.confirmResetPassword({ username: email, confirmationCode: code, newPassword });
    },
    logout: async () => {
      try {
        const auth = await loadAmplify(pub);
        await auth.signOut();
      } finally {
        setBearerTokenProvider(null);
        setIdTokenProvider(null);
        setUser(null);
        void refreshCaps();
      }
    },
    reload,
  }), [user, loading, login, pub, afterSignIn, reload, refreshCaps]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
