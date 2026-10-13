// backend/src/http/routes/me.ts —— GET /api/me（当前用户）、/api/me/outbox（只显示收件人是本人的 outbox 邮件，email=outbox）
// 脚手架桩：下列路径一律返回 501。由「L0 本地实现者」实现（保持 register(app, c) 的签名；具体路由按需细化）。
import type { Express } from 'express';
import type { Container } from '../../container.js';
import { notImplementedRoute } from './_stub.js';

export const PATHS = [
  '/api/me',
  '/api/me/*rest',
] as const;

export function register(app: Express, _c: Container): void {
  app.all([...PATHS], notImplementedRoute('me'));
}
