/**
 * 顶栏的语言切换（09 §1.1，决定 I1）：日本語 / English / 中文。选择保存在 localStorage；`onChanged` 用于登录后同步到
 * 个人资料（PATCH /me { locale }）与清理按语言缓存的数据。切换后 LocaleRoot 让应用按新语言原地重新渲染（不重新挂载、不整页刷新）。
 * 语言名用各语言的自称，不翻译；控件的可见名称来自词典（当前语言）。
 */
import { useId } from 'react';
import './i18n.css';
import { LOCALE_NAMES, LOCALES, isLocale, type Locale } from './locale';
import { useLocale } from './hooks';
import { msg, setLocale } from './runtime';

function Globe() {
  return (
    <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true" focusable="false">
      <circle cx="10" cy="10" r="7.5" />
      <path d="M2.5 10h15M10 2.5c2.2 2.1 3.2 4.6 3.2 7.5S12.2 15.4 10 17.5M10 2.5C7.8 4.6 6.8 7.1 6.8 10s1 5.4 3.2 7.5" />
    </svg>
  );
}

export interface LanguageSwitcherProps {
  className?: string;
  /** 切换完成后调用（例如同步到个人资料）；失败不影响切换。 */
  onChanged?: (locale: Locale) => void;
}

export function LanguageSwitcher({ className, onChanged }: LanguageSwitcherProps) {
  const locale = useLocale();
  const id = useId();
  return (
    <span className={`lang-switch${className ? ` ${className}` : ''}`}>
      <Globe />
      <label className="sr" htmlFor={id}>
        {msg.i18n.switcher}
      </label>
      <select
        id={id}
        value={locale}
        onChange={(e) => {
          const next = e.target.value;
          if (!isLocale(next) || next === locale) return;
          setLocale(next);
          onChanged?.(next);
        }}
      >
        {LOCALES.map((l) => (
          <option key={l} value={l} lang={l}>
            {LOCALE_NAMES[l]}
          </option>
        ))}
      </select>
    </span>
  );
}
