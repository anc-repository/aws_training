/**
 * SPA 入口（08 §0）。不使用内联脚本（CSP script-src 'self'，01 §10.6）：主题、语言在这里设置；
 * 运行时配置 /config.json 以 fetch 读取后再创建服务（认证、API 客户端、SessionSync）。
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './ui/styles/index.css';
import { App } from './app/App';
import { createServices } from './app/services';
import { applyTheme } from './app/theme';
import { loadConfig } from './auth/config';
import { zhCN } from './i18n/zh-CN';

document.documentElement.lang = 'zh-CN';
applyTheme();

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('#root is missing');
const root = createRoot(rootEl);

function ConfigError() {
  return (
    <main className="pub" id="main">
      <div className="empty">
        <h1>{zhCN.p13.platformUnavailableTitle}</h1>
        <p>{zhCN.auth.configFailed}</p>
        <button type="button" className="btn" onClick={() => window.location.reload()}>
          {zhCN.app.retry}
        </button>
      </div>
    </main>
  );
}

loadConfig()
  .then((config) => {
    const services = createServices({ config });
    void services.auth.init();
    window.addEventListener('pagehide', () => services.sync.dispose());
    root.render(
      <StrictMode>
        <App services={services} />
      </StrictMode>,
    );
  })
  .catch(() => root.render(<ConfigError />));
