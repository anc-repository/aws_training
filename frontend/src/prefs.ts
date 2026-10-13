// 每个浏览器自己的偏好（主题、是否显示架构徽章、路径追踪抽屉）。只放“便利性”状态：读写都包在 try/catch 里，
// 隐私模式或禁用存储时页面照常工作（总纲 12.3：用户设置里有“显示架构徽章”开关）。
import { useSyncExternalStore } from 'react';

export type ThemePref = 'system' | 'light' | 'dark';

export interface Prefs {
  theme: ThemePref;
  showBadges: boolean;
  /** EXPOSE_PATH_HEADERS=all 时普通用户也可以用 ?trace=1 打开路径追踪抽屉 */
  traceEnabled: boolean;
}

const KEY = 'cloudalbum.prefs.v1';
const DEFAULTS: Prefs = { theme: 'system', showBadges: true, traceEnabled: false };

function read(): Prefs {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<Prefs>;
    return {
      theme: parsed.theme === 'light' || parsed.theme === 'dark' ? parsed.theme : 'system',
      showBadges: parsed.showBadges !== false,
      traceEnabled: parsed.traceEnabled === true,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

let current: Prefs = read();
const listeners = new Set<() => void>();

export function getPrefs(): Prefs {
  return current;
}

export function setPrefs(patch: Partial<Prefs>): void {
  current = { ...current, ...patch };
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(current));
  } catch {
    /* 存储不可用时只在内存中生效 */
  }
  applyTheme(current.theme);
  for (const l of listeners) l();
}

/** 测试用：恢复默认值 */
export function resetPrefs(): void {
  current = { ...DEFAULTS };
  for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function usePrefs(): Prefs {
  return useSyncExternalStore(subscribe, getPrefs, getPrefs);
}

/** 写到 <html data-theme>；system = 去掉属性，跟随 prefers-color-scheme */
export function applyTheme(theme: ThemePref): void {
  const root = globalThis.document?.documentElement;
  if (!root) return;
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
}

export function nextTheme(theme: ThemePref): ThemePref {
  return theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system';
}

export const THEME_LABEL: Record<ThemePref, string> = { system: '跟随系统', light: '亮色', dark: '暗色' };
