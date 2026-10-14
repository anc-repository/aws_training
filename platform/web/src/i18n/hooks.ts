/**
 * React 绑定（09 §1.2）：当前语言（变化时重新渲染）。
 */
import { useSyncExternalStore } from 'react';
import type { Locale } from './locale';
import { getLocale, subscribeLocale } from './runtime';

export function useLocale(): Locale {
  return useSyncExternalStore(subscribeLocale, getLocale, getLocale);
}
