// backend/src/http/routes/auth.ts —— F1：注册、邮箱验证、登录、刷新、登出、找回密码、MFA（/api/auth/*，Nginx 对其单独 limit_req）
// 脚手架桩：下列路径一律返回 501。由「auth 模块实现者（local 流程由 L0 本地实现者完成）」实现（保持 register(app, c) 的签名；具体路由按需细化）。
import type { Express } from 'express';
import type { Container } from '../../container.js';
import { notImplementedRoute } from './_stub.js';

export const PATHS = [
  '/api/auth/*rest',
] as const;

export function register(app: Express, _c: Container): void {
  app.all([...PATHS], notImplementedRoute('auth'));
}
