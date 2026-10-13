// backend/src/http/routes/admin.ts —— F12：管理后台 API（用户、outbox、定时任务 job_runs、审计 audit_log、手动触发任务）
// 脚手架桩：下列路径一律返回 501。由「L0 本地实现者」实现（保持 register(app, c) 的签名；具体路由按需细化）。
import type { Express } from 'express';
import type { Container } from '../../container.js';
import { notImplementedRoute } from './_stub.js';

export const PATHS = [
  '/api/admin/*rest',
] as const;

export function register(app: Express, _c: Container): void {
  app.all([...PATHS], notImplementedRoute('admin'));
}
