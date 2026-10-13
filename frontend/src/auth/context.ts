// 认证上下文的类型与 Context 对象（叶子模块：capabilities 组件也会读它，避免循环依赖）。
import { createContext, useContext } from 'react';
import type { Me } from '../api/types';

export type AuthProviderKind = 'local' | 'cognito';
/** embedded = 本站表单经 BFF 登录（local，以及 cognito 的 sdk 子模式）；managed = 跳转 Cognito 托管登录页；
 *  amplify = 浏览器经 aws-amplify 直接与 Cognito 交互（lab 选读变体） */
export type AuthMode = 'embedded' | 'managed' | 'amplify';

export type LoginOutcome =
  | { kind: 'ok' }
  | { kind: 'mfa'; challengeId: string }
  | { kind: 'reset-required'; message?: string };

export interface RegisterOutcome {
  needsConfirmation: boolean;
  restrictedSession?: boolean;
}

export interface AuthContextValue {
  provider: AuthProviderKind;
  mode: AuthMode;
  /** 当前用户；null = 未登录 */
  user: Me | null;
  /** 首次读取 /api/me 期间为 true */
  loading: boolean;
  isAdmin: boolean;
  login(email: string, password: string): Promise<LoginOutcome>;
  completeMfa(challengeId: string, code: string): Promise<void>;
  register(input: { email: string; password: string; displayName: string }): Promise<RegisterOutcome>;
  confirm(email: string, code: string): Promise<void>;
  resend(email: string): Promise<void>;
  forgot(email: string): Promise<void>;
  reset(email: string, code: string, newPassword: string): Promise<void>;
  logout(): Promise<void>;
  /** managed：跳转到 /api/auth/login（BFF 发起授权码 + PKCE） */
  startHostedLogin?: () => void;
  reload(): Promise<void>;
}

export const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth 必须在 <AuthProvider> 内使用');
  return ctx;
}

export function useAuthOptional(): AuthContextValue | null {
  return useContext(AuthContext);
}

export function isAdminUser(user: Me | null): boolean {
  return Boolean(user && (user.role === 'admin' || user.groups?.includes('admin')));
}
