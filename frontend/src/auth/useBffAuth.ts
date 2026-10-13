// BFF 会话（HttpOnly Cookie）的通用实现：auth=local 与 auth=cognito 的 sdk / managed 子模式共用。
// 前端 JS 不接触任何令牌；/api/auth/* 由后端按驱动转给本地流程或 Cognito（02 组 auth 决定 a）。
import { useCallback, useEffect, useMemo, useState } from 'react';
import { onUnauthorized } from '../api/client';
import { authApi } from '../api/endpoints';
import type { Me } from '../api/types';
import { useCapabilities } from '../capabilities/useCapability';
import { isAdminUser, type AuthContextValue, type AuthMode, type AuthProviderKind, type LoginOutcome } from './context';

export function useBffAuth(provider: AuthProviderKind, mode: AuthMode): AuthContextValue {
  const { refresh: refreshCaps } = useCapabilities();
  const [user, setUser] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    try {
      setUser(await authApi.me());
    } catch {
      // 401 = 未登录；网络错误、5xx、501（后端桩）同样按未登录处理，页面照常可浏览公开内容
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    onUnauthorized(() => setUser(null));
    return () => onUnauthorized(null);
  }, []);

  const afterSessionChange = useCallback(async (me?: Me) => {
    if (me) setUser(me);
    else await reload();
    // 管理员与普通用户看到的 capabilities 视图不同
    void refreshCaps();
  }, [reload, refreshCaps]);

  const login = useCallback(async (email: string, password: string): Promise<LoginOutcome> => {
    const r = await authApi.login({ email, password });
    if (r.kind === 'mfa_required') return { kind: 'mfa', challengeId: r.challengeId };
    if (r.kind === 'reset-required') return { kind: 'reset-required', ...(r.message ? { message: r.message } : {}) };
    await afterSessionChange(r.user);
    return { kind: 'ok' };
  }, [afterSessionChange]);

  const completeMfa = useCallback(async (challengeId: string, code: string) => {
    const r = await authApi.mfaVerify({ challengeId, code });
    await afterSessionChange(r.kind === 'tokens' ? r.user : undefined);
  }, [afterSessionChange]);

  const register = useCallback(async (input: { email: string; password: string; displayName: string }) => {
    const r = await authApi.register(input);
    if (r.restrictedSession) await reload();
    return { needsConfirmation: r.needsConfirmation, ...(r.restrictedSession ? { restrictedSession: true } : {}) };
  }, [reload]);

  const confirm = useCallback(async (email: string, code: string) => {
    await authApi.confirm({ email, code });
    await reload();
  }, [reload]);

  const logout = useCallback(async () => {
    try {
      await authApi.logout();
    } finally {
      setUser(null);
      void refreshCaps();
    }
  }, [refreshCaps]);

  const startHostedLogin = useCallback(() => {
    const returnTo = `${globalThis.location?.pathname ?? '/'}${globalThis.location?.search ?? ''}`;
    globalThis.location?.assign(`/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`);
  }, []);

  return useMemo<AuthContextValue>(() => ({
    provider,
    mode,
    user,
    loading,
    isAdmin: isAdminUser(user),
    login,
    completeMfa,
    register,
    confirm,
    resend: (email) => authApi.resend(email),
    forgot: (email) => authApi.forgot(email),
    reset: (email, code, newPassword) => authApi.reset({ email, code, newPassword }),
    logout,
    reload,
    ...(mode === 'managed' ? { startHostedLogin } : {}),
  }), [provider, mode, user, loading, login, completeMfa, register, confirm, logout, reload, startHostedLogin]);
}
