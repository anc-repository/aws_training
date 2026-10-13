/**
 * 路由守卫（08 §2.4 表 1），纯函数，表驱动测试见 guards.test.ts。顺序：
 * 1 没有访问令牌也没有可用的刷新令牌 → /login?next=…（首次访问不带 reason）
 * 2 刷新失败 → /login?next=…&reason=expired
 * 3 cognito:groups 为空 → P13“账号未分配角色”
 * 4 平台配置读取失败（GET /platform 连续失败）→ P13“平台暂时不可用”（保留地址）
 * 5 PlatformConfig.mode = UNINSTALLING → 允许进入（全部只读画面），并标记卸载中（横幅、开始 / 延长 / 保留置灰）
 * 6 学员首次设置未完成 → /setup?next=…（/setup、/settings/*、/sessions/*、/resources/manual、/workspace/* 不受此规则约束；
 *   工作台内改为显示一次可关闭的提示）
 * 7 路由要求的角色不满足 → P13“角色不足”（不重定向，保留地址）
 */
import type { PlatformMode } from '@atl/shared';
import type { Role } from '../auth/jwt';

export interface GuardInput {
  /** 当前地址（路径 + 查询串），写入 next。 */
  location: string;
  auth: {
    authenticated: boolean;
    /** 曾经登录过（有过刷新令牌或刚被其他标签页退出）：决定 reason=expired。 */
    hadSession: boolean;
    signedOutElsewhere?: boolean;
  };
  principal: { groups: readonly string[]; role: Role | null } | null;
  platform: { status: 'loading' | 'ok' | 'failed'; mode?: PlatformMode | null };
  onboardingDone: boolean;
  route: { roles: readonly Role[]; onboardingExempt?: boolean; workspace?: boolean };
}

export type GuardDecision =
  | { kind: 'redirect'; to: string }
  | { kind: 'loading' }
  | { kind: 'no-role' }
  | { kind: 'platform-unavailable' }
  | { kind: 'role-denied' }
  | { kind: 'allow'; uninstalling: boolean; onboardingNotice: boolean };

export function loginRedirect(location: string, reason?: 'expired' | 'signed-out' | 'reauth' | 'signed-out-elsewhere'): string {
  const q = new URLSearchParams({ next: location });
  if (reason) q.set('reason', reason);
  return `/login?${q.toString()}`;
}

/** 不受“首次设置”规则约束的路径（表 1 第 6 条）：/setup、/settings/*、/sessions/*、/resources/manual、/workspace/*。 */
export function isOnboardingExempt(pathname: string): boolean {
  const under = (p: string) => pathname === p || pathname.startsWith(`${p}/`);
  return under('/setup') || under('/settings') || under('/sessions') || pathname === '/resources/manual' || under('/workspace');
}

export type AccessInput = Pick<GuardInput, 'location' | 'auth' | 'principal' | 'platform'>;
export type RouteInput = Pick<GuardInput, 'location' | 'principal' | 'platform' | 'onboardingDone' | 'route'>;

/** 表 1 第 1～4 条：与具体路由无关（全局框架在渲染顶栏之前判断）。 */
export function evaluateAccess(i: AccessInput): GuardDecision {
  if (!i.auth.authenticated) {
    const reason = i.auth.signedOutElsewhere ? 'signed-out-elsewhere' : i.auth.hadSession ? 'expired' : undefined;
    return { kind: 'redirect', to: loginRedirect(i.location, reason) };
  }
  if (!i.principal || i.principal.groups.length === 0 || !i.principal.role) return { kind: 'no-role' };
  if (i.platform.status === 'failed') return { kind: 'platform-unavailable' };
  if (i.platform.status === 'loading') return { kind: 'loading' };
  return { kind: 'allow', uninstalling: i.platform.mode === 'UNINSTALLING', onboardingNotice: false };
}

/** 表 1 第 5～7 条：按路由判断（首次设置、角色）。 */
export function evaluateRoute(i: RouteInput): GuardDecision {
  const role = i.principal?.role ?? null;
  const uninstalling = i.platform.mode === 'UNINSTALLING';
  const pathname = i.location.split(/[?#]/)[0] ?? '/';
  const exempt = i.route.onboardingExempt ?? isOnboardingExempt(pathname);
  let onboardingNotice = false;
  if (role === 'L' && !i.onboardingDone) {
    if (!exempt) return { kind: 'redirect', to: `/setup?${new URLSearchParams({ next: i.location }).toString()}` };
    onboardingNotice = !!i.route.workspace;
  }
  if (!role || !i.route.roles.includes(role)) return { kind: 'role-denied' };
  return { kind: 'allow', uninstalling, onboardingNotice };
}

/** 表 1 全部 7 条。 */
export function evaluateGuard(i: GuardInput): GuardDecision {
  const access = evaluateAccess(i);
  return access.kind === 'allow' ? evaluateRoute(i) : access;
}
