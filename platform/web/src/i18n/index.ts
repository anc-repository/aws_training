/**
 * 界面多语言（docs/platform/09-i18n-and-visual.md §1）：ja（默认）、en、zh-CN（源语言）。
 *
 *   msg            当前语言的文案（结构与 zh-CN 词典相同）：`msg.app.retry`、`msg.labs.ui.catalog.title`
 *   t / rich       占位代入（`{name}`、复数）；rich 把占位换成 React 节点
 *   getLocale / setLocale / useLocale / subscribeLocale
 *   fmt*           Intl 格式化（日期、时刻、数字、金额、列表、相对时间）
 *   contentUrl / fetchContentJson / untranslated   按语言读取卡片内容与“未翻译”判断
 * 组件：LanguageSwitcher（顶栏）、Untranslated（标记）、LocaleRoot（切换时原地重新渲染）各自从所在文件导入，避免循环依赖。
 */
export { DEFAULT_LOCALE, INTL_TAG, LOCALE_NAMES, LOCALES, SOURCE_LOCALE, fallbackChain, isLocale, type Locale } from './locale';
export { getLocale, loadLocale, localeReady, missingKeys, msg, registerLocaleDict, setLocale, subscribeLocale } from './runtime';
export { useLocale, useReloadOnLocale } from './hooks';
export { joinSoftBreaks, placeholders, t, withoutOptionalMark, type Vars } from './text';
export { rich } from './template';
export { fmtClock, fmtDate, fmtDay, fmtList, fmtMoney, fmtNumber, fmtPercent, fmtRelative, intlTag } from './format';
export { actualLang, contentI18n, contentUrl, fallbackLang, fetchContentJson, manualUntranslated, sourceContentUrl, untranslated, type ContentI18n } from './content';
export { textOf, withText } from './meta';
export type { Messages } from './zh-CN';
