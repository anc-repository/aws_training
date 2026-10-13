// ATL SPA（08 §0、01 §13）。只有 SPA 一个入口：证书公开验证页 /verify/*（P09-V）由 atl-certs 生成并发布
// （platform/api/src/services/certificates/static-site.ts），这里不再打包占位的 verify/，以免 WebDeploy 用占位页覆盖它。
// 构建产物与安装无关：Cognito 池、客户端、域名全部来自运行时的 /config.json（安装时由 WebDeploy 覆盖，01 §10.6）。
// 开发时（npm run platform:dev 或 npm run dev -w @atl/web）把 /api、/content、/__dev 代理到 platform/api 的 dev-server。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const root = path.dirname(fileURLToPath(import.meta.url));
const api = process.env.ATL_API_URL ?? `http://127.0.0.1:${process.env.ATL_DEV_PORT ?? '8787'}`;
const port = Number(process.env.ATL_WEB_PORT ?? 5174);

export default defineConfig({
  root,
  plugins: [react()],
  resolve: {
    alias: [{ find: /^@atl\/shared$/, replacement: path.join(root, '../shared/src/index.ts') }],
  },
  server: {
    host: '127.0.0.1',
    port,
    strictPort: true,
    proxy: {
      '/api': { target: api, changeOrigin: false },
      '/content': { target: api, changeOrigin: false },
      '/__dev': { target: api, changeOrigin: false },
    },
  },
  preview: { host: '127.0.0.1', port, strictPort: true, proxy: { '/api': api, '/content': api, '/__dev': api } },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    assetsDir: 'assets',
    // CSP `script-src 'self'`、`style-src 'self'`（01 §10.6）：不内联任何脚本与样式
    assetsInlineLimit: 0,
  },
});
