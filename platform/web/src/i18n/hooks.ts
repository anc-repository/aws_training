/**
 * React 绑定（09 §1.2）：当前语言（变化时重新渲染）；语言变化后重取数据。
 */
import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { Locale } from './locale';
import { getLocale, subscribeLocale } from './runtime';

export function useLocale(): Locale {
  return useSyncExternalStore(subscribeLocale, getLocale, getLocale);
}

/**
 * 语言变化后调用 `reload`（首次渲染不调用；`reload` 为 null 时什么也不做）。数据 hook 用它在原地重新渲染时按新语言重取
 * 内容与 API 数据（LocaleRoot 不再重新挂载应用，09 §1.2）。
 */
export function useReloadOnLocale(reload: (() => unknown) | null): void {
  const locale = useLocale();
  const seen = useRef(locale);
  const fn = useRef(reload);
  fn.current = reload;
  useEffect(() => {
    if (seen.current === locale) return;
    seen.current = locale;
    void fn.current?.();
  }, [locale]);
}
