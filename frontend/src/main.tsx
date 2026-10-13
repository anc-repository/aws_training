// 前端入口：主题、Resource Timing 采集、（仅开发模式）模拟后端，然后渲染 App。
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { applyTheme, getPrefs, setPrefs } from './prefs';
import { startResourceObserver } from './trace/resourceTiming';
import './styles/global.css';

applyTheme(getPrefs().theme);
try {
  // EXPOSE_PATH_HEADERS=all 时，所有人都可以用 ?trace=1 打开路径追踪抽屉（总纲 7.4 第 2 条）
  const trace = new URLSearchParams(globalThis.location.search).get('trace');
  if (trace === '1') setPrefs({ traceEnabled: true });
  if (trace === '0') setPrefs({ traceEnabled: false });
} catch {
  /* 忽略 */
}
startResourceObserver();

async function boot(): Promise<void> {
  // 开发模式：后端还是 501 桩或没有启动时，用浏览器内的模拟后端（生产构建中这段与 src/mock 一起被移除）
  if (import.meta.env.DEV) {
    const [{ installMockApi, resolveMockMode }, { loadRegistry }] = await Promise.all([
      import('./mock/install'),
      import('./capabilities/registry'),
    ]);
    await installMockApi(resolveMockMode(import.meta.env.VITE_CLOUDALBUM_MOCK), await loadRegistry());
  }
  const el = document.getElementById('root');
  if (!el) return;
  createRoot(el).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void boot();
