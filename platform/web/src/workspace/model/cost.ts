/**
 * 费用的显示（08 P05.2 费用计、P05.9 延长与结束；02 §10.2）。金额只来自服务端的报价与估算，界面不写任何价格常量；
 * 取不到时显示“未提供”。会话视图的 `env.hourlyEstimate` 有三种写法（§9.2 #30）：字符串、`{low, high}`、报价的 `hourly{start, completed}`。
 */

export interface Range {
  low: number;
  high: number;
}

export interface HourlyRange extends Range {
  currency: string;
  priceAsOf: string | null;
}

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function rangeOf(v: unknown): Range | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (isNum(o.low) && isNum(o.high)) return { low: o.low, high: o.high };
  return null;
}

/** 会话视图或报价中的每小时估算 → 区间；字符串形式视为“未提供”（§9.2 #30 的降级）。 */
export function hourlyRangeOf(estimate: unknown, currency = 'USD', priceAsOf: string | null = null): HourlyRange | null {
  if (!estimate || typeof estimate !== 'object') return null;
  const o = estimate as Record<string, unknown>;
  const direct = rangeOf(o);
  const cur = typeof o.currency === 'string' ? o.currency : currency;
  const asOf = typeof o.priceAsOf === 'string' ? o.priceAsOf : typeof o.asOf === 'string' ? o.asOf : priceAsOf;
  if (direct) return { ...direct, currency: cur, priceAsOf: asOf };
  // 报价的 hourly{start, completed}：实验中按“当前环境实际启用的资源”取 completed，没有时取 start
  const r = rangeOf(o.completed) ?? rangeOf(o.start);
  return r ? { ...r, currency: cur, priceAsOf: asOf } : null;
}

const SYMBOL: Record<string, string> = { USD: '$', CNY: '¥', EUR: '€', JPY: '¥' };

export function formatMoney(n: number, currency = 'USD'): string {
  const sym = SYMBOL[currency] ?? `${currency} `;
  if (n === 0) return `${sym}0.00`;
  const digits = n >= 100 ? 0 : n >= 1 ? 2 : n >= 0.01 ? 3 : 4;
  return `${sym}${n.toFixed(digits)}`;
}

/** “≈ $0.12～$0.20”；没有区间时“未提供”。 */
export function formatRange(r: Range | null, currency = 'USD'): string {
  if (!r) return '未提供';
  if (r.low === r.high) return `≈ ${formatMoney(r.low, currency)}`;
  return `≈ ${formatMoney(r.low, currency)}～${formatMoney(r.high, currency)}`;
}

/** 区间乘以小时数（延长 0.5 小时、保留 4 小时……）。 */
export function scaleRange(r: Range | null, hours: number): Range | null {
  return r ? { low: r.low * hours, high: r.high * hours } : null;
}

export interface QuoteView {
  quoteId: string;
  purpose?: string;
  currency?: string;
  priceAsOf?: string | null;
  expiresAt?: string | null;
  hourly?: { start?: Range | null; completed?: Range | null } | null;
  retainHourly?: number | Range | null;
  lines?: { group?: string; service?: string; dimension?: string; detail?: string; billing?: string; unknown?: boolean; perHourLow?: number; perHourHigh?: number }[];
  incomplete?: string[];
  notes?: string[];
  pricing?: string;
  disclaimer?: string;
  requiresTypedConfirm?: boolean;
  minutes?: number;
  keepHours?: number;
}

/** 报价的每小时区间（保留优先取 retainHourly）。 */
export function quoteHourly(q: QuoteView | null, purpose: 'EXTEND' | 'KEEP'): Range | null {
  if (!q) return null;
  if (purpose === 'KEEP') {
    if (isNum(q.retainHourly)) return { low: q.retainHourly, high: q.retainHourly };
    const r = rangeOf(q.retainHourly);
    if (r) return r;
  }
  return rangeOf(q.hourly?.completed) ?? rangeOf(q.hourly?.start);
}

/** `GET /sessions/{sid}/cost` 的已产生估算（字段写法不统一，按常见名称取）。 */
export function accruedOf(cost: unknown): Range | null {
  if (!cost || typeof cost !== 'object') return null;
  const o = cost as Record<string, unknown>;
  return rangeOf(o.accrued) ?? rangeOf(o.estimate) ?? rangeOf(o.incurred) ?? rangeOf(o.total);
}
