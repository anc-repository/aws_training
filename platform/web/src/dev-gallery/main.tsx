/**
 * 视觉组件展示页的入口（开发专用）：npm run dev -w @atl/web 后打开 http://127.0.0.1:5174/src/dev-gallery/
 * （/__dev/* 已代理给 API 的 dev-server，所以不用那个前缀）。查询串：?theme=light|dark&lang=ja|en|zh-CN&card=<id>。
 * 生产构建只以根目录 index.html 为入口，本目录不会进入 dist/。
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../ui/styles/index.css';
import { Gallery } from './Gallery';
import './gallery.css';

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <Gallery />
    </StrictMode>,
  );
}
