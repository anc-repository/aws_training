// backend/src/http/routes/_stub.ts —— “未实现”的桩路由：返回 501 NOT_IMPLEMENTED（不是 404，便于区分“没写”与“不存在”）
import type { RequestHandler } from 'express';

export function notImplementedRoute(component: string): RequestHandler {
  return (req, res) => {
    res.status(501).json({
      error: 'NOT_IMPLEMENTED',
      component,
      method: req.method,
      path: req.path,
      message: `${component} 路由尚未实现（脚手架桩）`,
    });
  };
}
