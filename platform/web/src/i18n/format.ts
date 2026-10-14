/**
 * 按语言格式化（09 §1.4，决定 I1）：日期、时间、数字、货币、列表与相对时间一律用 Intl，语言取当前界面语言。
 * zh-CN 保持 08 §1.6 的写法（当年 `10/13 10:42`、跨年 `2026-10-13`、24 小时制），ja / en 用各自的 Intl 习惯写法。
 * 时长与倒计时见 lib/format.ts（单位文案在词典 `fmt` 中）。
 */
import { INTL_TAG, type Locale } from './locale';
import { getLocale } from './runtime';

const cache = new Map<string, Intl.DateTimeFormat | Intl.NumberFormat | Intl.ListFormat | Intl.RelativeTimeFormat>();

function cached<T extends Intl.DateTimeFormat | Intl.NumberFormat | Intl.ListFormat | Intl.RelativeTimeFormat>(key: string, make: () => T): T {
  let f = cache.get(key) as T | undefined;
  if (!f) {
    f = make();
    cache.set(key, f);
  }
  return f;
}

export function intlTag(l: Locale = getLocale()): string {
  return INTL_TAG[l];
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** 24 小时制时刻 `16:30`（本地时区）。 */
export function fmtClock(t: number | string | Date, l: Locale = getLocale()): string {
  const d = new Date(t);
  if (l === 'zh-CN') return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return cached(`clock:${l}`, () => new Intl.DateTimeFormat(INTL_TAG[l], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })).format(d);
}

/** 当年：月日 + 时刻；跨年：年月日（08 §1.6）。 */
export function fmtDate(t: number | string | Date, now: number = Date.now(), l: Locale = getLocale()): string {
  const d = new Date(t);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  if (l === 'zh-CN') return sameYear ? `${d.getMonth() + 1}/${d.getDate()} ${fmtClock(d, l)}` : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  if (sameYear) {
    return cached(`md:${l}`, () =>
      new Intl.DateTimeFormat(INTL_TAG[l], { month: l === 'en' ? 'short' : 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }),
    ).format(d);
  }
  return cached(`ymd:${l}`, () => new Intl.DateTimeFormat(INTL_TAG[l], { year: 'numeric', month: l === 'en' ? 'short' : '2-digit', day: '2-digit' })).format(d);
}

/** 只有日期（证书、报告封面）：`2026-10-13` / `2026/10/13` / `Oct 13, 2026`。 */
export function fmtDay(t: number | string | Date, l: Locale = getLocale()): string {
  const d = new Date(t);
  if (l === 'zh-CN') return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return cached(`day:${l}`, () => new Intl.DateTimeFormat(INTL_TAG[l], { year: 'numeric', month: l === 'en' ? 'short' : '2-digit', day: '2-digit' })).format(d);
}

export function fmtNumber(n: number, opts: Intl.NumberFormatOptions = {}, l: Locale = getLocale()): string {
  return cached(`num:${l}:${JSON.stringify(opts)}`, () => new Intl.NumberFormat(INTL_TAG[l], opts)).format(n);
}

export function fmtPercent(ratio: number, digits = 0, l: Locale = getLocale()): string {
  return fmtNumber(ratio, { style: 'percent', maximumFractionDigits: digits }, l);
}

/** 金额（估算值，不写“免费”）；保留到分以下的小额时最多 4 位小数。 */
export function fmtMoney(amount: number, currency = 'USD', l: Locale = getLocale()): string {
  const digits = Math.abs(amount) > 0 && Math.abs(amount) < 0.1 ? 4 : 2;
  return fmtNumber(amount, { style: 'currency', currency, currencyDisplay: 'narrowSymbol', minimumFractionDigits: 2, maximumFractionDigits: digits }, l);
}

export function fmtList(items: readonly string[], type: 'conjunction' | 'disjunction' | 'unit' = 'conjunction', l: Locale = getLocale()): string {
  return cached(`list:${l}:${type}`, () => new Intl.ListFormat(INTL_TAG[l], { type, style: 'long' })).format(items);
}

/** 相对时间：“3 分钟前”“3 分前”“3 minutes ago”。 */
export function fmtRelative(value: number, unit: Intl.RelativeTimeFormatUnit, l: Locale = getLocale()): string {
  return cached(`rel:${l}`, () => new Intl.RelativeTimeFormat(INTL_TAG[l], { numeric: 'auto' })).format(value, unit);
}
