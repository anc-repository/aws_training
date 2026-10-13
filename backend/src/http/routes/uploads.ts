// backend/src/http/routes/uploads.ts —— F6 本地签名直传 PUT /api/storage/upload；F14 前缀令牌：POST /api/uploads/session、GET /api/storage/upload/parts、POST /api/uploads/parts:sign、GET /api/uploads/credentials
// 脚手架桩：下列路径一律返回 501。由「L0 本地实现者（storage / identity-pool 的 AWS 分支由对应模块实现者补充）」实现（保持 register(app, c) 的签名；具体路由按需细化）。
import type { Express } from 'express';
import type { Container } from '../../container.js';
import { notImplementedRoute } from './_stub.js';

export const PATHS = [
  '/api/uploads/*rest',
  '/api/storage/upload',
  '/api/storage/upload/*rest',
] as const;

export function register(app: Express, _c: Container): void {
  app.all([...PATHS], notImplementedRoute('uploads'));
}
