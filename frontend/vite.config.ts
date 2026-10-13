// Vite 配置。构建产物与模块无关（总纲 12.1）：不使用任何与模块相关的构建期变量，Cognito 池 ID、CDN 域名等全部来自运行时的
// /api/capabilities。开发时把 API 代理到本机的 cloudalbum-api（npm run dev --workspace @cloudalbum/backend）。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const root = path.dirname(fileURLToPath(import.meta.url));
const api = process.env.CLOUDALBUM_API ?? 'http://localhost:3000';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      { find: /^@cloudalbum\/contracts\/registry$/, replacement: path.join(root, '../packages/contracts/src/generated/registry.ts') },
      { find: /^@cloudalbum\/contracts$/, replacement: path.join(root, '../packages/contracts/src/index.ts') },
    ],
  },
  server: {
    port: 5173,
    proxy: {
      '/api': api,
      '/social': api,
      '/media': api,
      '/.well-known': api,
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    assetsDir: 'assets',            // Nginx：/assets/ 长缓存（immutable），index.html no-cache
  },
});
