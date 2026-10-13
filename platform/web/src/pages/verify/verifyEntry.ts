/**
 * `verify/verify.js` 的入口（public-pages/build.mjs 以 IIFE 打包；不引用 React 与 SPA 的任何模块）。
 * 页面 `verify/index.html` 以 `<script src="/verify/verify.js" defer>` 加载它。
 */
import { boot } from './verifyPage';

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
}
