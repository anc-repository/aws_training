// backend/src/http/routes/lab.ts —— /api/lab/*：runs、metrics、requests/recent、self-check、faults、results、侧路对比与功能对照端点（§7.3、§8）
// 脚手架桩：下列路径一律返回 501。由「L0 本地实现者」实现（保持 register(app, c) 的签名；具体路由按需细化）。
import type { Express } from 'express';
import type { Container } from '../../container.js';
import { notImplementedRoute } from './_stub.js';

export const PATHS = [
  '/api/lab/*rest',
] as const;

export function register(app: Express, _c: Container): void {
  app.all([...PATHS], notImplementedRoute('lab'));
}
