/**
 * 不依赖 React 的 i18n 入口（09 §1.2）：供纯函数模块、公开分享副本渲染器（Node 中也会运行）使用。
 * 组件请从 `../i18n`（index.ts）导入；两者导出的 `msg`、`t` 是同一个对象 / 函数。
 */
export { DEFAULT_LOCALE, INTL_TAG, LOCALE_NAMES, LOCALES, SOURCE_LOCALE, fallbackChain, isLocale, type Locale } from './locale';
export { getLocale, missingKeys, msg, setLocale, subscribeLocale } from './runtime';
export { placeholders, t, type Vars } from './text';
export { fmtClock, fmtDate, fmtDay, fmtList, fmtMoney, fmtNumber, fmtPercent, fmtRelative, intlTag } from './format';
export { textOf, withText } from './meta';
export type { Messages } from './zh-CN';
