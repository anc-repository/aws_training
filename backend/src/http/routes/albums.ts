// backend/src/http/routes/albums.ts —— F5：相册 CRUD（GET 走 dbRead 与 cache.wrap；X-Compare-Bypass: cache / replica）
// 脚手架桩：下列路径一律返回 501。由「L0 本地实现者」实现（保持 register(app, c) 的签名；具体路由按需细化）。
import type { Express } from 'express';
import type { Container } from '../../container.js';
import { notImplementedRoute } from './_stub.js';

export const PATHS = [
  '/api/albums',
  '/api/albums/*rest',
] as const;

export function register(app: Express, _c: Container): void {
  app.all([...PATHS], notImplementedRoute('albums'));
}
