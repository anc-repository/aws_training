/**
 * 语言切换后的同步（09 §1.1）：丢弃按语言缓存的 API 响应（ETag），已登录时尽力同步到个人资料（PATCH /me { locale }；失败不影响切换）。
 * 顶栏（GlobalBar 的 LanguageSwitcher）与工作台（SessionBar 的“更多”菜单）共用；ETag 缓存另外在 services.ts 订阅语言时就丢弃。
 */
import { useCallback } from 'react';
import type { Locale } from '../i18n';
import { useAuth, useServices } from './context';

export function useLocaleSync(): (l: Locale) => void {
  const { api } = useServices();
  const authed = useAuth().status === 'authenticated';
  return useCallback(
    (l: Locale) => {
      api.invalidate();
      if (authed) void api.call('patchMe', { body: { locale: l } }).catch(() => undefined);
    },
    [api, authed],
  );
}
