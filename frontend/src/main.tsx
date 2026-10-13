// 前端入口（脚手架占位）。由「前端实现者」按总纲 §11 的 frontend/src 结构填充：
// capabilities/（CapabilitiesProvider、ModuleBadge、Feature）、auth/（LocalAuthProvider、CognitoAuthProvider 动态 import aws-amplify）、
// api/client.ts（捕获 Server-Timing / X-CloudAlbum-Path）、upload/、trace/（路径追踪抽屉）、pages/、lab/。
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';

const el = document.getElementById('root');
if (el) {
  createRoot(el).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
