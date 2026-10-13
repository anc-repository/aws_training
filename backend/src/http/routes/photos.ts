// backend/src/http/routes/photos.ts —— F5–F8：照片、时间线（GET /api/feed）、搜索；POST /api/photos 返回 UploadTarget，POST /api/photos/:id/complete 走 PhotoPipeline
// 脚手架桩：下列路径一律返回 501。由「L0 本地实现者」实现（保持 register(app, c) 的签名；具体路由按需细化）。
import type { Express } from 'express';
import type { Container } from '../../container.js';
import { notImplementedRoute } from './_stub.js';

export const PATHS = [
  '/api/photos',
  '/api/photos/*rest',
  '/api/feed',
  '/api/search',
] as const;

export function register(app: Express, _c: Container): void {
  app.all([...PATHS], notImplementedRoute('photos'));
}
