// Vitest 全局设置：每个用例后卸载 React 树、清空存储与播报状态、恢复 fetch 与广播工厂。
// 界面语言固定为 zh-CN（现有用例按源语言的文案断言；其他语言的用例自己切换并在结束时恢复，09 §1.7）。
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';
import { getLocale, setLocale } from '../i18n';
import { resetAnnouncements } from '../lib/announce';
import { setBroadcastFactory } from '../lib/broadcast';
import { resetBannerAnnouncements } from '../ui/Banner';

const originalFetch = globalThis.fetch;

setLocale('zh-CN', { persist: false });

beforeEach(() => {
  if (getLocale() !== 'zh-CN') setLocale('zh-CN', { persist: false });
});

afterEach(() => {
  cleanup();
  resetAnnouncements();
  resetBannerAnnouncements();
  setBroadcastFactory(null);
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.getElementById('root')?.removeAttribute('inert');
  try {
    globalThis.sessionStorage?.clear();
    globalThis.localStorage?.clear();
  } catch {
    /* 忽略 */
  }
});
