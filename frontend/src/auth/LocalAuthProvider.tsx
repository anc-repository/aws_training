// auth=local：内置的注册、登录、找回密码、MFA 表单，经 BFF（/api/auth/*）由 EC2 处理（argon2id + ES256 JWT）。
import type { ReactNode } from 'react';
import { AuthContext } from './context';
import { useBffAuth } from './useBffAuth';

export function LocalAuthProvider({ children }: { children: ReactNode }) {
  const value = useBffAuth('local', 'embedded');
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
