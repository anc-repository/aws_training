/**
 * 全站横幅的来源与优先级（08 §3.6 表），纯函数，测试见 globalBanners.test.ts。
 * 工作台内部的横幅（T-15、预期中断、平台动作、访问已收回）由 P05 自己管理，不进入这里（同一件事一屏只说一次）。
 */
import type { GuardrailsView, ManualResourcesView, PlatformView, SessionView } from '../api/types';
import type { Role } from '../auth/jwt';
import { msg, t } from '../i18n';
import { formatClock, formatDate } from '../lib/format';
import type { BannerTone, ShapeName } from '../ui';

export interface GlobalBannerAction {
  label: string;
  to?: string;
  /** 刷新整页（目录 / 平台已更新）。 */
  reload?: boolean;
}

export interface GlobalBanner {
  id: string;
  priority: number;
  tone: BannerTone;
  shape: ShapeName;
  text: string;
  dismissible: boolean;
  action?: GlobalBannerAction;
}

export interface BannerInput {
  role: Role | null;
  platform: PlatformView | null;
  guardrails: GuardrailsView | null;
  current: SessionView | null;
  /** 服务端时间。 */
  nowMs: number;
  /** 当前在工作台（工作台内的横幅由 P05 管理）。 */
  onWorkspace: boolean;
  manual: ManualResourcesView | null;
  catalogUpdatedTo: string | null;
  /** 收到 env.degraded 且尚未收到 env.recovered（§7.5）。 */
  envDegraded: boolean;
}

const LIVE = ['READY', 'RUNNING', 'EXPIRING'];

export function computeGlobalBanners(i: BannerInput): GlobalBanner[] {
  const out: GlobalBanner[] = [];
  const b = msg.banners;
  const uninstalling = i.platform?.mode === 'UNINSTALLING' || i.guardrails?.uninstalling === true;
  // 1 平台卸载中
  if (uninstalling) {
    out.push({ id: 'uninstall', priority: 1, tone: 'red', shape: 'sq', text: b.uninstalling, dismissible: false, action: { label: b.uninstallingAction, to: '/settings/uninstall' } });
  }
  // 2 释放未完成（O 不显示：无权读取，也不能处理）
  if (i.role !== 'O' && i.manual) {
    const open = i.manual.items.filter((m) => m.cleanupState !== 'RESOLVED_BY_LEARNER' && m.cleanupState !== 'DELETED');
    if (open.some((m) => m.severity === 'BLOCKING')) {
      const first = open.find((m) => m.labId || m.sessionCreatedAt) ?? open[0]!;
      const what = first.labId
        ? first.sessionCreatedAt
          ? t(msg.frame.residualOf, { labId: first.labId, t: formatDate(first.sessionCreatedAt, i.nowMs) })
          : first.labId
        : b.residualPrevious;
      const hourly = open.filter((m) => m.billing === 'hourly').length;
      out.push({
        id: 'residual',
        priority: 2,
        tone: 'red',
        shape: 'tri',
        text: t(b.residual, { what, n: open.length, hourly: hourly ? t(b.residualHourly, { n: hourly }) : '' }),
        dismissible: false,
        action: { label: b.residualAction, to: '/resources/manual' },
      });
    }
  }
  // 3 预算超限
  if (i.guardrails?.budget?.state === 'EXCEEDED') {
    out.push({ id: 'budget-exceeded', priority: 3, tone: 'red', shape: 'sq', text: b.budgetExceeded, dismissible: false, action: { label: b.budgetAction, to: '/settings/guardrails' } });
  }
  const cur = i.current;
  // 4 即将到期（非工作台页面）
  if (cur && cur.state === 'EXPIRING' && !i.onWorkspace && cur.deadlineAt) {
    const left = Math.max(0, Math.ceil((Date.parse(cur.deadlineAt) - i.nowMs) / 60_000));
    out.push({
      id: `expiring-${cur.sessionId}-${cur.deadlineVersion ?? 0}`,
      priority: 4,
      tone: 'amber',
      shape: 'tri',
      text: t(b.expiring, { labId: cur.labId, at: formatClock(cur.deadlineAt), min: left }),
      dismissible: true,
      action: { label: b.expiringAction, to: `/workspace/${cur.sessionId}` },
    });
  }
  // 5 环境异常（预期中断窗口内抑制）
  const inOutage = !!cur?.outageWindow?.until && Date.parse(cur.outageWindow.until) > i.nowMs;
  if (cur && i.envDegraded && !inOutage && !i.onWorkspace && LIVE.includes(cur.state)) {
    out.push({ id: `env-degraded-${cur.sessionId}`, priority: 5, tone: 'amber', shape: 'tri', text: b.envDegraded, dismissible: true, action: { label: b.envDegradedAction, to: `/workspace/${cur.sessionId}` } });
  }
  // 6 维护模式
  if (i.platform?.maintenance || i.guardrails?.maintenance) {
    out.push({
      id: 'maintenance',
      priority: 6,
      tone: 'grey',
      shape: 'hg',
      text: b.maintenance,
      dismissible: false,
      ...(i.role === 'L' ? { action: { label: b.maintenanceAction, to: '/settings/platform' } } : {}),
    });
  }
  // 7 预算接近
  if (i.guardrails?.budget?.state === 'WARN') {
    out.push({ id: 'budget-warn', priority: 7, tone: 'amber', shape: 'tri', text: b.budgetWarn, dismissible: true, action: { label: b.budgetAction, to: '/settings/guardrails' } });
  }
  // 8 目录已更新
  if (i.catalogUpdatedTo) {
    out.push({ id: 'catalog-updated', priority: 8, tone: 'blue', shape: 'dot', text: t(b.catalogUpdated, { v: i.catalogUpdatedTo }), dismissible: true, action: { label: b.refresh, reload: true } });
  }
  // 9 保留中的环境（距 keep.until ≤ 60 分钟）
  const keepUntil = cur?.keep?.until ?? cur?.env?.keepUntil ?? null;
  if (cur && cur.state === 'KEPT' && keepUntil && Date.parse(keepUntil) - i.nowMs <= 60 * 60_000) {
    out.push({
      id: `keep-${cur.sessionId}`,
      priority: 9,
      tone: 'kept',
      shape: 'dia',
      text: t(b.keep, { at: formatClock(keepUntil) }),
      dismissible: true,
      action: { label: b.keepAction, to: `/sessions/${cur.sessionId}/end` },
    });
  }
  return out.sort((a, c) => a.priority - c.priority);
}
