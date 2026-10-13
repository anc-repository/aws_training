/**
 * 访问令牌的声明（不验签：签名由 API Gateway 的 JWT 授权器与 atl-api 校验，01 §5.3）。
 * 界面只用它决定角色（`cognito:groups`，01 §5.2）、过期时间与最近一次真实登录时间（`auth_time`）。
 * 开发令牌 `dev.<group>.<sub>[.<authTime>]` 按 dev-server 的格式解析（platform/api/src/dev/adapters/auth.ts）。
 */
import { COGNITO_GROUPS, type CognitoGroup } from '@atl/shared';

export type Role = 'L' | 'A' | 'O';

export interface Principal {
  sub: string;
  username: string;
  email: string | null;
  groups: CognitoGroup[];
  /** 界面角色：learner > assistant > observer；没有组时为 null（P13 #8“账号未分配角色”）。 */
  role: Role | null;
  /** 最近一次真实登录（秒）。 */
  authTime: number | null;
  /** 访问令牌过期时间（毫秒）；开发令牌为 null。 */
  expiresAt: number | null;
}

export function roleOf(groups: readonly string[]): Role | null {
  if (groups.includes('learner')) return 'L';
  if (groups.includes('assistant')) return 'A';
  if (groups.includes('observer')) return 'O';
  return null;
}

function base64UrlDecode(s: string): string {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const v = JSON.parse(base64UrlDecode(parts[1])) as unknown;
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const DEV_TOKEN = /^dev\.(learner|assistant|observer)\.([A-Za-z0-9_-]{1,64})(?:\.(\d{9,11}))?$/;

export function isDevToken(token: string): boolean {
  return DEV_TOKEN.test(token);
}

export function principalFromToken(token: string, nowSec: number = Math.floor(Date.now() / 1000)): Principal | null {
  const dev = DEV_TOKEN.exec(token);
  if (dev) {
    const group = dev[1] as CognitoGroup;
    return {
      sub: dev[2]!,
      username: dev[2]!,
      email: `${dev[2]}@dev.invalid`,
      groups: [group],
      role: roleOf([group]),
      authTime: dev[3] ? Number(dev[3]) : nowSec,
      expiresAt: null,
    };
  }
  const p = decodeJwtPayload(token);
  if (!p || typeof p.sub !== 'string') return null;
  const raw = Array.isArray(p['cognito:groups']) ? (p['cognito:groups'] as unknown[]) : [];
  const groups = raw.filter((g): g is CognitoGroup => typeof g === 'string' && (COGNITO_GROUPS as readonly string[]).includes(g));
  return {
    sub: p.sub,
    username: typeof p.username === 'string' ? p.username : typeof p['cognito:username'] === 'string' ? (p['cognito:username'] as string) : p.sub,
    email: typeof p.email === 'string' ? p.email : null,
    groups,
    role: roleOf(groups),
    authTime: typeof p.auth_time === 'number' ? p.auth_time : null,
    expiresAt: typeof p.exp === 'number' ? p.exp * 1000 : null,
  };
}
