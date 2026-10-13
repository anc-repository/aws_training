// backend/src/ports/auth.ts （总纲 §4.2，照录；02 组文档的 signIn/signUp 等是 flows 的展开，端口以本文件为准）
import type { Adapter, Migratable } from './common.js';

export interface Principal {
  provider: 'local' | 'cognito';
  subject: string;                   // 本地用户 id 或 Cognito sub；业务表用的是 users.id（内部 UUID）
  email: string;
  emailVerified: boolean;
  groups: string[];                  // 'admin' | 'member'
  plan: string;                      // F4（以 users 表为准）
  expiresAt: number;
}
/** BFF + HttpOnly Cookie：ca_at（access）、ca_rt（refresh）、ca_it（ID 令牌，identity-pool 与 social-api 需要） */
export interface TokenSet { accessToken: string; refreshToken: string; expiresIn: number; idToken?: string }
export type LoginResult = { kind: 'tokens'; tokens: TokenSet } | { kind: 'mfa_required'; challengeId: string };

export interface AuthPublicConfig {                 // 经 /api/capabilities 下发给前端
  driver: 'local' | 'cognito';
  userPoolId?: string; userPoolClientId?: string; region?: string; hostedUiDomain?: string;
  passwordPolicy: { minLength: number; requireUpper: boolean; requireDigit: boolean; requireSymbol: boolean };
  mfa: 'off' | 'optional' | 'required';
  /** integration 细化（可选）：前端登录方式。local = 本站表单（BFF）；cognito：sdk 子模式 = 浏览器经 Amplify 直连 User Pool（'amplify'），
   *  managed = 托管登录页。publicClientId = 不带密钥的 SPA App Client（infra 的 auth.yaml 只创建这种客户端） */
  loginMode?: 'embedded' | 'amplify' | 'managed';
  publicClientId?: string;
}

/** 只有本地驱动提供：注册、登录、找回密码等流程由 EC2 处理 */
export interface EmbeddedAuthFlows {
  register(input: { email: string; password: string; displayName: string }): Promise<{ subject: string; needsConfirmation: boolean }>;
  confirmRegistration(email: string, code: string): Promise<void>;
  resendCode(email: string): Promise<void>;
  login(email: string, password: string): Promise<LoginResult>;
  completeMfa(challengeId: string, totp: string): Promise<TokenSet>;
  refresh(refreshToken: string): Promise<TokenSet>;
  logout(refreshToken: string): Promise<void>;
  forgotPassword(email: string): Promise<void>;
  confirmForgotPassword(email: string, code: string, newPassword: string): Promise<void>;
  setupTotp(subject: string): Promise<{ otpauthUrl: string }>;
  verifyTotp(subject: string, code: string): Promise<void>;
}

/** 迁移时导出的身份；不含密码哈希——密码无法跨驱动迁移。默认 AUTH_MIGRATION=bulk：迁移后首次登录走“重置密码”（D8） */
export interface ExportedIdentity {
  subject: string; email: string; emailVerified: boolean; groups: string[]; plan: string; mfaEnabled: boolean;
}

export interface AuthPort extends Adapter, Migratable<ExportedIdentity> {
  /** 驱动 id 只能是 'local' | 'cognito'（= AUTH_DRIVER）；cognito 的 sdk / managed 子模式写进路径头 outcome */
  publicConfig(): AuthPublicConfig;
  /** 两种驱动都必须实现：校验签名、过期、token_use、client_id（cognito 用 aws-jwt-verify + JWKS 缓存；
   *  local 用 ES256 公钥，并比对 tv 声明与 users.token_version，登出后旧令牌立即失效） */
  verifyAccessToken(token: string): Promise<Principal>;
  /** local：返回当前与上一版本 kid 的 ES256 公钥，由 GET /.well-known/jwks.json 发布；cognito：null（JWKS 由 User Pool 发布） */
  jwks(): { keys: Array<Record<string, string>> } | null;
  /** null = 浏览器直接与 Cognito 交互（Amplify / Managed Login），EC2 不经手密码 */
  readonly flows: EmbeddedAuthFlows | null;
  adminSetGroups(subject: string, groups: string[]): Promise<void>;
  adminDisableUser(subject: string): Promise<void>;
}
// 本地签名私钥：SecretsPort.get('jwt-signing-key')（env 驱动 = JWT_SIGNING_KEY_FILE 指向 keys/jwt-es256.pem）。
// 遇到未知 kid 时强制刷新一次密钥缓存（有频率限制），以支持轮换后的多实例。
