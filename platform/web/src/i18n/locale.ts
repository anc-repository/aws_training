/**
 * 界面语言（docs/platform/09-i18n-and-visual.md §1，决定 I1 / I2）。
 *
 * - 语言：ja（默认）、en、zh-CN（源语言）。第一次访问一律日语，不按浏览器语言自动切换；
 * - 选择保存在 localStorage（`atl.locale.v1`），并在登录后尽力同步到个人资料（PATCH /me { locale }）；
 * - 回退链：所选语言 → en → zh-CN；
 * - `<html lang>` 跟随当前语言。
 */
import { lsGet, lsSet, STORAGE_KEYS } from '../lib/storage';

export type Locale = 'ja' | 'en' | 'zh-CN';

/** 顶栏切换器的顺序（I1：日本語 / English / 中文）。 */
export const LOCALES: readonly Locale[] = ['ja', 'en', 'zh-CN'];
export const DEFAULT_LOCALE: Locale = 'ja';
/** 源语言：词典与内容以它为准，其他语言缺失时最终回退到它。 */
export const SOURCE_LOCALE: Locale = 'zh-CN';

/** 语言的自称（切换器里不翻译）。 */
export const LOCALE_NAMES: Readonly<Record<Locale, string>> = { ja: '日本語', en: 'English', 'zh-CN': '中文' };

/** Intl 使用的语言标签。 */
export const INTL_TAG: Readonly<Record<Locale, string>> = { ja: 'ja-JP', en: 'en-US', 'zh-CN': 'zh-CN' };

export function isLocale(v: unknown): v is Locale {
  return v === 'ja' || v === 'en' || v === 'zh-CN';
}

/** 所选语言 → en → zh-CN（去重）。 */
export function fallbackChain(l: Locale): Locale[] {
  const out: Locale[] = [l];
  for (const x of ['en', 'zh-CN'] as const) if (!out.includes(x)) out.push(x);
  return out;
}

/** 保存的选择；没有（第一次访问）或无效时为日语（不读 navigator.language）。 */
export function storedLocale(): Locale {
  const v = lsGet<unknown>(STORAGE_KEYS.locale, null);
  return isLocale(v) ? v : DEFAULT_LOCALE;
}

/** 是否已经做过选择（个人资料同步只在已选择时进行）。 */
export function hasStoredLocale(): boolean {
  return isLocale(lsGet<unknown>(STORAGE_KEYS.locale, null));
}

export function persistLocale(l: Locale): void {
  lsSet(STORAGE_KEYS.locale, l);
}

export function applyHtmlLang(l: Locale): void {
  if (typeof document !== 'undefined') document.documentElement.lang = l;
}
