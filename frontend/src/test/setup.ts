// vitest 的全局设置：每个用例后卸载 React 树、清空路径追踪与偏好，恢复被替换的 fetch。
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';
import { resetPrefs } from '../prefs';
import { resetTraceStore } from '../trace/TraceStore';

const originalFetch = globalThis.fetch;

afterEach(() => {
  cleanup();
  resetTraceStore();
  resetPrefs();
  globalThis.fetch = originalFetch;
  delete (globalThis as { __CLOUDALBUM_MOCK__?: string }).__CLOUDALBUM_MOCK__;
  vi.restoreAllMocks();
  try {
    globalThis.sessionStorage?.clear();
    globalThis.localStorage?.clear();
  } catch {
    /* 忽略 */
  }
});
