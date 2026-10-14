// ATL SPA（08 §0、01 §13）。只有 SPA 一个入口：证书公开验证页 /verify/*（P09-V，public-pages/ 单独构建）由 atl-certs 发布
// （platform/api/build.mjs 把构建产物嵌入函数包，static-site.ts verifyPageAssets），不进 atl-web.zip，以免 WebDeploy 覆盖它。
// 构建产物与安装无关：Cognito 池、客户端、域名全部来自运行时的 /config.json（安装时由 WebDeploy 覆盖，01 §10.6）。
// 开发时（npm run platform:dev、npm run e2e:platform 或 npm run dev -w @atl/web）把 /api、/content、/__dev 与公开文件代理到
// platform/api 的 dev-server。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const root = path.dirname(fileURLToPath(import.meta.url));
const api = process.env.ATL_API_URL ?? `http://127.0.0.1:${process.env.ATL_DEV_PORT ?? '8787'}`;
const port = Number(process.env.ATL_WEB_PORT ?? 5174);
// 与 CloudFront 相同的同源路径：API、静态内容、dev 控制端点，以及 atl-certs 发布的公开文件（验证页、JWKS、公开证书、分享副本）
const devProxy = Object.fromEntries(['/api', '/content', '/__dev', '/verify', '/.well-known', '/public/', '/share/'].map((p) => [p, { target: api, changeOrigin: false }]));

export default defineConfig({
  root,
  plugins: [react()],
  resolve: {
    alias: [
      { find: /^@atl\/shared$/, replacement: path.join(root, '../shared/src/index.ts') },
      // 终端协议层（03 §3.5）按源码打包（工作台按需加载，不进首屏包）
      { find: /^@atl\/ssm-client$/, replacement: path.join(root, '../ssm-client/src/index.ts') },
    ],
  },
  server: {
    host: '127.0.0.1',
    port,
    strictPort: true,
    proxy: devProxy,
  },
  // e2e:platform serves the production build with the CloudFront CSP of 70-web.yaml (ATL_WEB_CSP) to catch CSP violations
  preview: { host: '127.0.0.1', port, strictPort: true, proxy: devProxy, ...(process.env.ATL_WEB_CSP ? { headers: { 'content-security-policy': process.env.ATL_WEB_CSP } } : {}) },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    assetsDir: 'assets',
    // CSP `script-src 'self'`、`style-src 'self'`（01 §10.6）：不内联任何脚本与样式
    assetsInlineLimit: 0,
  },
});
