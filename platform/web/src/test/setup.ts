// Vitest 全局设置：每个用例后卸载 React 树、清空存储与播报状态、恢复 fetch 与广播工厂。
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';
import { resetAnnouncements } from '../lib/announce';
import { setBroadcastFactory } from '../lib/broadcast';
import { resetBannerAnnouncements } from '../ui/Banner';

const originalFetch = globalThis.fetch;

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
