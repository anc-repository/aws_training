/**
 * P13 全局错误与降级：画面内（行内 / 区块级）的错误处理规则（08 P13 表第 2、3、4、7、9、10、11、19、34 条；§4.0 通用状态约定）。
 * 纯函数：把 ApiError 归类为界面要做的事——重试、等待倒计时、刷新后重新操作、只读说明、或显示 title + requestId。
 * 全局层（离线条、登录过期、需要最近登录、横幅、错误边界、角色不足页）由 src/components 负责；这里只管画面内部。
 */
import type { ApiError } from '../../api/errors';
import { msg, t } from '../../i18n';

export type ProblemKind =
  /** 网络不可达（P13 #1；离线条由全局显示，画面内给重试）。 */
  | 'network'
  /** 平台 API 不可用（#2）：区块级 ErrorPanel + 重试。 */
  | 'unavailable'
  /** AWS 被限流（#3）：行内琥珀提示。 */
  | 'throttled'
  /** 应用级限速（#4）：按钮下方倒计时，结束后恢复。 */
  | 'rate-limited'
  /** 角色不足（#7）：原位置说明，不弹窗。 */
  | 'role'
  /** 需要最近登录（#6）：由全局 ReauthDialog 处理，画面只显示一句说明。 */
  | 'reauth'
  /** 会话状态冲突（§4.0）：刷新会话视图后按新状态重绘。 */
  | 'state'
  /** 版本冲突（#19）：行内“刚刚变化，已刷新”。 */
  | 'precondition'
  /** 维护 / 卸载 / 预算阻止（#9、#10、#11）。 */
  | 'blocked'
  /** 没有找到。 */
  | 'not-found'
  /** 其他已知错误码：查文案表。 */
  | 'known'
  /** 未知错误码（#34）：title、detail、requestId + 复制诊断信息。 */
  | 'unknown';

export interface Problem {
  kind: ProblemKind;
  /** 学员看到的一句话（发生了什么 / 你可以做什么）。 */
  message: string;
  /** 允许“重试”。 */
  retry: boolean;
  /** 等待秒数（#4）。 */
  retryAfterSec: number | null;
  /** 需要刷新会话视图（状态冲突、版本冲突）。 */
  refreshView: boolean;
  /** 行内提示的色调（note.<tone>）。 */
  tone: 'red' | 'amber' | 'blue' | 'grey';
}

const ROLE_TEXT: Record<string, string> = msg.roles;

export function describeProblem(err: ApiError | null | undefined, opts: { role?: 'L' | 'A' | 'O' | null; overrides?: Record<string, string> } = {}): Problem | null {
  if (!err) return null;
  const code = String(err.code ?? '');
  const over = opts.overrides?.[code];
  const known = over ?? msg.errors[code];
  const fill = (tpl: string) => t(tpl, { detail: err.detail ?? '', requestId: err.requestId ?? '—', n: err.retryAfterSec ?? 30 });
  const base = { retry: false, retryAfterSec: null, refreshView: false, tone: 'red' as const };
  if (code === 'NETWORK' || err.status === 0) return { ...base, kind: 'network', message: msg.errors.NETWORK!, retry: true, tone: 'grey' };
  if (code === 'RATE_LIMITED' || err.status === 429) {
    const n = err.retryAfterSec ?? 30;
    return { ...base, kind: 'rate-limited', message: t(msg.p13.rateLimited, { n }), retryAfterSec: n, tone: 'amber' };
  }
  if (code === 'UPSTREAM_THROTTLED') return { ...base, kind: 'throttled', message: msg.p13.throttled, retry: true, retryAfterSec: err.retryAfterSec, tone: 'amber' };
  if (code === 'REAUTH_REQUIRED') return { ...base, kind: 'reauth', message: msg.errors.REAUTH_REQUIRED!, tone: 'blue' };
  if (code === 'FORBIDDEN_ROLE' || (err.status === 403 && !known)) {
    const role = opts.role ? ROLE_TEXT[opts.role] : '—';
    return { ...base, kind: 'role', message: t(msg.p13.roleDeniedInline, { role }), tone: 'grey' };
  }
  if (code === 'PRECONDITION_FAILED') return { ...base, kind: 'precondition', message: over ?? msg.errors.PRECONDITION_FAILED!, refreshView: true, tone: 'blue' };
  if (code === 'INVALID_STATE' || code === 'SESSION_EXPIRING_OR_ENDED') return { ...base, kind: 'state', message: fill(known ?? msg.errors.INVALID_STATE!), refreshView: true, tone: 'blue' };
  if (code === 'MAINTENANCE_MODE' || code === 'PLATFORM_UNINSTALLING' || code === 'BUDGET_BLOCKED') return { ...base, kind: 'blocked', message: fill(known!), tone: 'amber' };
  if (err.status >= 500 || code === 'UPSTREAM_UNAVAILABLE' || code === 'INTERNAL') {
    return { ...base, kind: 'unavailable', message: code === 'INTERNAL' ? fill(msg.errors.INTERNAL!) : t(msg.p13.apiUnavailable, { status: err.status || 503 }), retry: true };
  }
  if (code === 'NOT_FOUND' || err.status === 404) return { ...base, kind: 'not-found', message: fill(known ?? msg.errors.NOT_FOUND!), tone: 'grey' };
  if (known) return { ...base, kind: 'known', message: fill(known) };
  return { ...base, kind: 'unknown', message: [err.title, err.detail].filter(Boolean).join('：') || code, retry: true };
}

/** 422 CERT_NOT_ELIGIBLE 等带原因列表的错误（problem.reasons）。 */
export function problemReasons(err: ApiError | null | undefined): unknown[] {
  const p = err?.problem as { reasons?: unknown } | null | undefined;
  return Array.isArray(p?.reasons) ? p!.reasons : [];
}
