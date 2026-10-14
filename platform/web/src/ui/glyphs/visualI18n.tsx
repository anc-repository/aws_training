/**
 * 视觉组件的 t() 适配层（docs/platform/09-i18n-and-visual.md「视觉组件」）。
 *
 * 全站 i18n 框架与本组件并行开发：组件只调用 useVisualI18n().t(key)，查找顺序为
 *   外部 translate(key)（框架接入后由 <VisualI18nProvider translate=…> 提供）→ 内置词典的所选语言 → en → zh-CN（I2 回退链）。
 * 没有 Provider 时语言取 <html lang>（ja / en / zh-*），取不到时用 ja（I1：默认日语）。
 * 数字、时长、列表一律用 Intl 按语言格式化（I1）。
 */
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { VISUAL_LANGS, VISUAL_MESSAGES, type VisualKey, type VisualLang } from './visualMessages';

export type { VisualKey, VisualLang } from './visualMessages';

export type VisualVars = Readonly<Record<string, string | number>>;
/** 外部翻译函数：没有这个键时返回 null / undefined（再走内置词典）。 */
export type ExternalTranslator = (key: string, vars?: VisualVars) => string | null | undefined;

export interface VisualI18n {
  lang: VisualLang;
  t: (key: VisualKey, vars?: VisualVars) => string;
  /** Intl 格式化的数字（百分比、整数）。 */
  number: (value: number, opts?: Intl.NumberFormatOptions) => string;
  /** “60 分”/“60 min”/“60分钟”（Intl unit: minute，short）。 */
  minutes: (n: number) => string;
  /** 并列的短语（Intl.ListFormat conjunction：ja「A、B」、en「A, B, and C」、zh「A、B和C」）。 */
  list: (items: readonly string[]) => string;
}

/** 'ja' | 'en' | 'zh-CN'；无法识别时为 ja（I1）。 */
export function resolveVisualLang(raw: string | null | undefined): VisualLang {
  const v = (raw ?? '').trim().toLowerCase();
  if (v.startsWith('zh')) return 'zh-CN';
  if (v.startsWith('en')) return 'en';
  return 'ja';
}

function interpolate(template: string, vars?: VisualVars): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

const warned = new Set<string>();

/** 纯函数版本（测试与非 React 代码用）。 */
export function visualT(lang: VisualLang, key: VisualKey, vars?: VisualVars, translate?: ExternalTranslator): string {
  const ext = translate?.(key, vars);
  if (ext != null) return ext;
  const chain: VisualLang[] = lang === 'en' ? ['en', 'zh-CN'] : lang === 'zh-CN' ? ['zh-CN'] : [lang, 'en', 'zh-CN'];
  for (const l of chain) {
    const hit = VISUAL_MESSAGES[l]?.[key];
    if (hit != null) {
      if (l !== lang && import.meta.env.DEV && import.meta.env.MODE !== 'test' && !warned.has(`${lang}:${key}`)) {
        warned.add(`${lang}:${key}`);
        console.warn(`[i18n] missing ${lang} translation for ${key}`);
      }
      return interpolate(hit, vars);
    }
  }
  return key;
}

const formatters = new Map<string, Intl.NumberFormat | Intl.ListFormat>();
function cached<T extends Intl.NumberFormat | Intl.ListFormat>(key: string, make: () => T): T {
  let f = formatters.get(key) as T | undefined;
  if (!f) {
    f = make();
    formatters.set(key, f);
  }
  return f;
}

export function makeVisualI18n(lang: VisualLang, translate?: ExternalTranslator): VisualI18n {
  return {
    lang,
    t: (key, vars) => visualT(lang, key, vars, translate),
    number: (value, opts) => cached(`n|${lang}|${JSON.stringify(opts ?? {})}`, () => new Intl.NumberFormat(lang, opts)).format(value),
    minutes: (n) =>
      cached(`m|${lang}`, () => new Intl.NumberFormat(lang, { style: 'unit', unit: 'minute', unitDisplay: 'short' })).format(n),
    list: (items) => {
      if (typeof Intl.ListFormat !== 'function') return items.join(lang === 'en' ? ', ' : '、');
      return cached(`l|${lang}`, () => new Intl.ListFormat(lang, { style: 'long', type: 'conjunction' })).format(items);
    },
  };
}

interface Ctx {
  lang: VisualLang;
  translate?: ExternalTranslator;
}
const VisualI18nContext = createContext<Ctx | null>(null);

export interface VisualI18nProviderProps {
  /** 当前语言（任意 BCP 47 写法，按 resolveVisualLang 归一）。 */
  lang: string;
  translate?: ExternalTranslator;
  children?: ReactNode;
}

/** i18n 框架接入点：<VisualI18nProvider lang={lang} translate={(k, v) => dict[k] ? t(k, v) : null}>。 */
export function VisualI18nProvider({ lang, translate, children }: VisualI18nProviderProps) {
  const value = useMemo<Ctx>(() => ({ lang: resolveVisualLang(lang), translate }), [lang, translate]);
  return <VisualI18nContext.Provider value={value}>{children}</VisualI18nContext.Provider>;
}

function documentLang(): VisualLang {
  return resolveVisualLang(typeof document === 'undefined' ? null : document.documentElement.getAttribute('lang'));
}

export function useVisualI18n(): VisualI18n {
  const ctx = useContext(VisualI18nContext);
  const lang = ctx?.lang ?? documentLang();
  const translate = ctx?.translate;
  return useMemo(() => makeVisualI18n(lang, translate), [lang, translate]);
}

export { VISUAL_LANGS };
