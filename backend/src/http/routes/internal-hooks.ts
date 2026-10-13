// backend/src/http/routes/internal-hooks.ts —— registry internalEndpoints 声明的内部端点（总纲 2.5 第 4 组 location）
//
// - POST /internal/hooks/image-processed：image-processing（lambda 档 + IMAGE_RESULT_CHANNEL=callback），公网可达 + HMAC
//   （callback-hmac-key，带时间戳 ±300 秒）；对应模块或变体未启用时返回 404。
// - POST /internal/legacy-auth：auth 的 lazy 迁移变体（只放行 VPC CIDR + internal-hmac-key）；本轮未实现。
// - 其余 /internal/* 一律 404。
// 脚手架桩：已声明的端点在启用条件满足时返回 501，由「image-processing 模块实现者」实现（HMAC 校验用 req.rawBody）。
import type { Express, RequestHandler } from 'express';
import type { Container } from '../../container.js';
import { notImplementedRoute } from './_stub.js';

export function register(app: Express, c: Container): void {
  const notFound: RequestHandler = (_req, res) => {
    res.status(404).json({ error: 'NOT_FOUND' });
  };
  const image = c.config.image;
  const imageCallbackEnabled = image.IMAGE_PROCESSOR === 'lambda' && image.IMAGE_RESULT_CHANNEL === 'callback';
  app.post('/internal/hooks/image-processed', imageCallbackEnabled ? notImplementedRoute('internal-hooks.image-processed') : notFound);
  app.all('/internal/*rest', notFound);
}
