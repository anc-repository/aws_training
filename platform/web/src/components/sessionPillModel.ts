/**
 * 顶栏会话胶囊的显示模型（08 §3.3 的 10 种外观、§6.3、§6.4），纯函数，测试见 sessionPillModel.test.ts。
 */
import type { SessionView } from '../api/types';
import { pillTarget } from '../app/sessionRouting';
import type { Role } from '../auth/jwt';
import { t, zhCN } from '../i18n/zh-CN';
import { formatClock, formatCountdown, formatRemainingSpoken } from '../lib/format';
import { COST_TIER_META, displayState, SESSION_STATE_META, urgencyOf, type CostTier, type ShapeName } from '../ui';

export interface PillModel {
  /** 链接去向（表 2 最后一列）；null = 不渲染胶囊。 */
  target: string;
  /** `.spill.<cls>` */
  cls: 'u-prep' | 'u-live' | 'u1' | 'u2' | 'u4' | 'u-wind' | 'u-kept' | 'u-fail';
  shape: ShapeName;
  spin: boolean;
  /** 状态文字（窄屏也保留）。 */
  label: string;
  /** 窄屏隐藏的中间部分（卡片 id 等）。 */
  detail: string[];
  /** 倒计时 / 计时器文字（等宽，aria-live="off"）；没有时 null。 */
  clock: string | null;
  /** 窄屏隐藏的尾部（费用档位、计数）。 */
  tail: string[];
  aria: string;
}

export interface PillInput {
  view: SessionView;
  /** 服务端时间。 */
  nowMs: number;
  role: Role | null;
  costTier?: CostTier | null;
}

export function pillModel({ view: v, nowMs, role, costTier }: PillInput): PillModel | null {
  const target = pillTarget(v);
  if (!target) return null;
  const tier = costTier ? `${COST_TIER_META[costTier].symbol} ${COST_TIER_META[costTier].text}` : null;
  const tierTail = tier ? [tier] : [];
  const remaining = v.deadlineAt ? Date.parse(v.deadlineAt) - nowMs : null;
  const ds = displayState(v.state, remaining);
  const s = zhCN.session;
  switch (ds) {
    case 'REQUESTED':
    case 'PROVISIONING': {
      const m = SESSION_STATE_META[ds];
      const elapsed = formatCountdown(nowMs - Date.parse(v.createdAt));
      return {
        target,
        cls: 'u-prep',
        shape: 'clock',
        spin: ds === 'PROVISIONING',
        label: m.text,
        detail: [v.labId],
        clock: t(s.elapsed, { t: elapsed }),
        tail: tierTail,
        aria: t(s.pillPrepLabel, { labId: v.labId, state: m.text }),
      };
    }
    case 'READY':
    case 'RUNNING':
    case 'EXPIRING': {
      const u = urgencyOf(remaining ?? Number.POSITIVE_INFINITY);
      const urgent = u !== 'U0';
      const stateText = urgent ? SESSION_STATE_META.EXPIRING.text : SESSION_STATE_META[ds].text;
      const rest = remaining !== null ? t(s.remaining, { t: formatRemainingSpoken(remaining) }) : s.countdownNotStarted;
      return {
        target,
        cls: u === 'U0' ? 'u-live' : u === 'U1' ? 'u1' : 'u2',
        shape: u === 'U0' ? 'dot' : u === 'U1' ? 'tri' : 'sq',
        spin: false,
        label: stateText,
        detail: [v.labId],
        clock: remaining !== null ? formatCountdown(remaining) : null,
        tail: tierTail,
        aria: `${t(s.pillLabel, { labId: v.labId, state: stateText, rest })}${tier ? `，费用档位${COST_TIER_META[costTier!].text}` : ''}`,
      };
    }
    case 'OVERDUE':
      return { target, cls: 'u4', shape: 'hg', spin: false, label: SESSION_STATE_META.OVERDUE.text, detail: [v.labId], clock: null, tail: [], aria: t(s.pillWindLabel, { labId: v.labId, state: SESSION_STATE_META.OVERDUE.text }) };
    case 'ENDING':
    case 'CLEANING': {
      const m = SESSION_STATE_META[ds];
      const c = v.cleanup;
      const count = ds === 'CLEANING' && role !== 'O' && c && typeof c.deleted === 'number' && typeof c.total === 'number' ? [t(s.deleted, { n: c.deleted, m: c.total })] : [];
      return { target, cls: 'u-wind', shape: 'hg', spin: false, label: m.text, detail: [v.labId], clock: null, tail: count, aria: t(s.pillWindLabel, { labId: v.labId, state: m.text }) };
    }
    case 'KEPT': {
      const until = v.keep?.until ?? v.env?.keepUntil ?? null;
      const tail = [...(until ? [t(s.until, { t: formatClock(until) })] : []), ...(v.keep?.saveMode ? [s.saveMode] : []), ...tierTail];
      return { target, cls: 'u-kept', shape: 'dia', spin: false, label: SESSION_STATE_META.KEPT.text, detail: [v.labId], clock: null, tail, aria: t(s.pillKeptLabel, { labId: v.labId }) };
    }
    case 'CLEANUP_FAILED': {
      const hourly = v.cleanup?.hourlyBlocking ?? 0;
      return {
        target,
        cls: 'u-fail',
        shape: 'tri',
        spin: false,
        label: SESSION_STATE_META.CLEANUP_FAILED.text,
        detail: [v.labId],
        clock: null,
        tail: hourly && role !== 'O' ? [t(s.hourlyBilled, { n: hourly })] : [],
        aria: t(s.pillFailedLabel, { labId: v.labId }),
      };
    }
    default:
      return null;
  }
}
