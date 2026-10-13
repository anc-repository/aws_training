// backend/src/http/middleware/frame-ancestors.ts —— HTML 响应的 CSP frame-ancestors（06 PM-20，应用侧）
//
// 工作台的“应用预览”用 iframe 嵌入 CloudAlbum：平台模式下所有 HTML 响应（Nginx 返回的 index.html 由槽位文件处理；
// 这里覆盖应用自己生成的 HTML，例如 OAuth 回调页、错误页）带 `Content-Security-Policy: frame-ancestors 'self' <ATL_PLATFORM_ORIGIN>`。
// 任何模式下都不发送 X-Frame-Options（现有设计本来就不发送）。平台模式关闭时什么都不做。
import type { RequestHandler } from 'express';
import { frameAncestorsValue } from '../../platform/env-schema.js';
import { platformMode, platformState } from '../../platform/mode.js';

export function frameAncestors(): RequestHandler {
  return (_req, res, next) => {
    if (!platformMode()) return next();
    const origin = platformState().origin;
    if (!origin) return next();
    const original = res.writeHead;
    res.writeHead = function writeHead(this: typeof res, ...args: unknown[]) {
      const type = String(res.getHeader('Content-Type') ?? '');
      if (/^text\/html\b/i.test(type) && !res.getHeader('Content-Security-Policy')) {
        res.setHeader('Content-Security-Policy', frameAncestorsValue(origin));
      }
      res.removeHeader('X-Frame-Options');
      return (original as (...a: unknown[]) => typeof res).apply(this, args);
    } as typeof res.writeHead;
    next();
  };
}
