// backend/src/http/routes/jwks.ts —— GET /.well-known/jwks.json：auth=local 的 ES256 公钥（当前与上一版本 kid，D8）；cognito 时 404
// 脚手架桩：下列路径一律返回 501。由「auth 模块实现者」实现（保持 register(app, c) 的签名；具体路由按需细化）。
import type { Express } from 'express';
import type { Container } from '../../container.js';
import { notImplementedRoute } from './_stub.js';

export const PATHS = [
  '/.well-known/jwks.json',
] as const;

export function register(app: Express, _c: Container): void {
  app.all([...PATHS], notImplementedRoute('jwks'));
}
