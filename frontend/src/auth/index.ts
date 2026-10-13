// 认证层入口：AuthProvider 按 capabilities 选择 LocalAuthProvider 或（动态加载的）CognitoAuthProvider。
export { AuthProvider } from './AuthProvider';
export { AuthContext, useAuth, useAuthOptional, isAdminUser } from './context';
export type { AuthContextValue, AuthMode, AuthProviderKind, LoginOutcome, RegisterOutcome } from './context';
export { authMode, authPublic, passwordProblems, type AuthPublic, type PasswordPolicy } from './config';
export { RequireAuth, RequireAdmin } from './guards';
