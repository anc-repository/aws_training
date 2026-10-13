/**
 * 主题（08 §6.11）：默认跟随系统；AccountMenu 中可选亮 / 暗；偏好存 localStorage（try/catch）。
 * 实现：<html data-theme="light|dark">，跟随系统时去掉属性（tokens.css 的 :root:not([data-theme="light"]) 媒体查询生效）。
 */
import { lsGet, lsSet, STORAGE_KEYS } from '../lib/storage';

export type ThemePref = 'system' | 'light' | 'dark';

export function getThemePref(): ThemePref {
  const v = lsGet<string>(STORAGE_KEYS.theme, 'system');
  return v === 'light' || v === 'dark' ? v : 'system';
}

export function applyTheme(pref: ThemePref = getThemePref(), root: HTMLElement = document.documentElement): void {
  if (pref === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', pref);
}

export function setThemePref(pref: ThemePref): void {
  lsSet(STORAGE_KEYS.theme, pref);
  applyTheme(pref);
}
