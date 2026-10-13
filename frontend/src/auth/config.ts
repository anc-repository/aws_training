// auth 的公开配置：来自 capabilities.modules.auth.public（AuthPort.publicConfig()，ports/auth.ts）。
import type { CapabilitiesResponse } from '@cloudalbum/contracts';
import type { AuthMode, AuthProviderKind } from './context';

export interface PasswordPolicy {
  minLength: number;
  requireUpper: boolean;
  requireDigit: boolean;
  requireSymbol: boolean;
}

export interface AuthPublic {
  driver: AuthProviderKind;
  userPoolId?: string;
  userPoolClientId?: string;
  /** Amplify 变体使用的“不带密钥”的公开 App Client（BFF 客户端带密钥，浏览器不能直接用） */
  publicClientId?: string;
  region?: string;
  hostedUiDomain?: string;
  /** COGNITO_LOGIN_MODE：sdk（默认）| managed；amplify 为 lab 选读变体 */
  loginMode?: 'sdk' | 'managed' | 'amplify';
  mfa: 'off' | 'optional' | 'required';
  passwordPolicy: PasswordPolicy;
}

export const DEFAULT_PASSWORD_POLICY: PasswordPolicy = { minLength: 8, requireUpper: false, requireDigit: true, requireSymbol: false };

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

export function authPublic(caps: CapabilitiesResponse): AuthPublic {
  const cap = caps.modules.auth;
  const pub = (cap?.public ?? {}) as Record<string, unknown>;
  const driver: AuthProviderKind = (str(pub['driver']) ?? cap?.driver) === 'cognito' ? 'cognito' : 'local';
  const pp = (pub['passwordPolicy'] ?? {}) as Partial<PasswordPolicy>;
  const mode = str(pub['loginMode']);
  const out: AuthPublic = {
    driver,
    mfa: pub['mfa'] === 'off' || pub['mfa'] === 'required' ? pub['mfa'] : 'optional',
    passwordPolicy: {
      minLength: typeof pp.minLength === 'number' ? pp.minLength : DEFAULT_PASSWORD_POLICY.minLength,
      requireUpper: Boolean(pp.requireUpper ?? DEFAULT_PASSWORD_POLICY.requireUpper),
      requireDigit: Boolean(pp.requireDigit ?? DEFAULT_PASSWORD_POLICY.requireDigit),
      requireSymbol: Boolean(pp.requireSymbol ?? DEFAULT_PASSWORD_POLICY.requireSymbol),
    },
  };
  const assign = (k: 'userPoolId' | 'userPoolClientId' | 'publicClientId' | 'region' | 'hostedUiDomain') => {
    const v = str(pub[k]);
    if (v) out[k] = v;
  };
  assign('userPoolId');
  assign('userPoolClientId');
  assign('publicClientId');
  assign('region');
  assign('hostedUiDomain');
  if (mode === 'sdk' || mode === 'managed' || mode === 'amplify') out.loginMode = mode;
  return out;
}

export function authMode(pub: AuthPublic): AuthMode {
  if (pub.driver === 'local') return 'embedded';
  if (pub.loginMode === 'managed') return 'managed';
  if (pub.loginMode === 'amplify') return 'amplify';
  return 'embedded';
}

/** 客户端预检（服务端仍会按同一策略与常见密码黑名单校验） */
export function passwordProblems(pw: string, policy: PasswordPolicy): string[] {
  const out: string[] = [];
  if (pw.length < policy.minLength) out.push(`至少 ${policy.minLength} 个字符`);
  if (policy.requireUpper && !/[A-Z]/.test(pw)) out.push('需要大写字母');
  if (policy.requireDigit && !/\d/.test(pw)) out.push('需要数字');
  if (policy.requireSymbol && !/[^A-Za-z0-9]/.test(pw)) out.push('需要符号');
  return out;
}
