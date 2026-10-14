/**
 * 会话、回收、报告与证书画面共用的取值 → 文案（08 §1.6、§4 P07/P08/P11；02 §6.1、§7.5）。纯数据，不含组件。
 * 状态的形状与颜色一律取 src/ui/semantics.ts（全站唯一映射），这里只有那张表之外的取值。
 */

import { t } from '../../i18n/core';
import { SN } from './strings';

const V = SN.values;

/** 02 §6.1 的 endReason（08 P11 列表“结束原因”）。 */
export const END_REASON_TEXT: Readonly<Record<string, string>> = V.endReason;

export function endReasonText(r: string | null | undefined): string {
  if (!r) return '—';
  return END_REASON_TEXT[r] ?? V.other;
}

/** 01 §7.3 SessionResource.discoveredBy（08 ResourceRow“来源”列）。 */
export const DISCOVERED_BY_TEXT: Readonly<Record<string, string>> = V.discoveredBy;

export function discoveredByText(v: string | null | undefined): string | null {
  if (!v) return null;
  return DISCOVERED_BY_TEXT[v] ?? v;
}

/** 02 §7.5 的删除阶段。 */
export const STAGES = ['S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6'] as const;
export type Stage = (typeof STAGES)[number];
export const STAGE_TEXT: Readonly<Record<string, string>> = V.stage;

/** 报告 `cleanup.status`（04 §9.2）。 */
export const REPORT_CLEANUP_TEXT: Readonly<Record<string, string>> = V.reportCleanup;

/** 徽章等级（05 §2.10、tracks §5.3）。 */
export const BADGE_LEVEL_TEXT: Readonly<Record<string, string>> = V.badgeLevel;

export const BADGE_STATUS_TEXT: Readonly<Record<string, string>> = V.badgeStatus;

/** 实验无效原因码（08 P06 变体状态表）。 */
export const VALIDITY_REASON_TEXT: Readonly<Record<string, string>> = V.validityReason;

export function validityReasonText(code: string): string {
  const base = code.split(/[:\s]/)[0]!;
  const text = VALIDITY_REASON_TEXT[base];
  return text ? (code.length > base.length ? t(V.withDetail, { text, detail: code.slice(base.length).replace(/^[:\s]+/, '') }) : text) : code;
}

/** 成对比较不可比的原因（GET /experiment-runs/compare 的 reasons）。 */
export const COMPARE_REASON_TEXT: Readonly<Record<string, string>> = V.compareReason;

/** 计费金额区间：`≈ 0.12～0.15 USD/小时`；没有金额时 null（调用方写“未知”）。不编造价格（08 写作约束）。 */
export function formatMoneyRange(low: number | null | undefined, high: number | null | undefined, currency = 'USD', unit = ''): string | null {
  const ok = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  if (!ok(low) && !ok(high)) return null;
  const f = (v: number) => (v >= 100 ? v.toFixed(0) : v >= 1 ? v.toFixed(2) : v.toPrecision(2));
  const a = ok(low) ? f(low) : '?';
  const b = ok(high) ? f(high) : '?';
  return a === b ? t(V.money, { amount: a, currency, unit }) : t(V.moneyRange, { low: a, high: b, currency, unit });
}

/** 会话视图 `env.hourlyEstimate` 的两种写法（08 §9.2 #30）：对象 `{start, completed}` / `{low, high}`，字符串视为未提供。 */
export function hourlyRange(v: unknown): { low: number | null; high: number | null } | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as { low?: unknown; high?: unknown; completed?: unknown; start?: unknown };
  const pick = (x: unknown) => (x && typeof x === 'object' ? (x as { low?: unknown; high?: unknown }) : null);
  const r = typeof o.low === 'number' || typeof o.high === 'number' ? o : (pick(o.completed) ?? pick(o.start));
  if (!r) return null;
  const low = typeof r.low === 'number' ? r.low : null;
  const high = typeof r.high === 'number' ? r.high : null;
  return low === null && high === null ? null : { low, high };
}
