/**
 * SPA 入口（08 §0）。不使用内联脚本（CSP script-src 'self'，01 §10.6）：主题在这里设置，语言由 i18n/runtime 在导入时设置
 * （localStorage 中的选择，没有时为日语；`<html lang>` 跟随，09 §1）；
 * 运行时配置 /config.json 以 fetch 读取后再创建服务（认证、API 客户端、SessionSync）。
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './ui/styles/index.css';
import { App } from './app/App';
import { createServices } from './app/services';
import { applyTheme } from './app/theme';
import { loadConfig } from './auth/config';
import { msg } from './i18n';
import { LocaleRoot } from './i18n/LocaleRoot';

applyTheme();

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('#root is missing');
const root = createRoot(rootEl);

function ConfigError() {
  return (
    <main className="pub" id="main">
      <div className="empty">
        <h1>{msg.p13.platformUnavailableTitle}</h1>
        <p>{msg.auth.configFailed}</p>
        <button type="button" className="btn" onClick={() => window.location.reload()}>
          {msg.app.retry}
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
        <LocaleRoot>
          <App services={services} />
        </LocaleRoot>
      </StrictMode>,
    );
  })
  .catch(() =>
    root.render(
      <LocaleRoot>
        <ConfigError />
      </LocaleRoot>,
    ),
  );
