// backend/src/http/routes/media.ts —— GET /media/*：校验签名与权限后返回 X-Accel-Redirect（local，路径头 storage=local:accel）或 302 到预签名 URL（s3）
// 脚手架桩：下列路径一律返回 501。由「L0 本地实现者（s3 分支由 storage 模块实现者补充）」实现（保持 register(app, c) 的签名；具体路由按需细化）。
import type { Express } from 'express';
import type { Container } from '../../container.js';
import { notImplementedRoute } from './_stub.js';

export const PATHS = [
  '/media/*rest',
] as const;

export function register(app: Express, _c: Container): void {
  app.all([...PATHS], notImplementedRoute('media'));
}
