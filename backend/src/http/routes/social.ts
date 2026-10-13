// backend/src/http/routes/social.ts —— F9、F11：点赞、评论、分享链接（/social/*，SocialStorePort；social-api 的 proxy 集成也回源到这里）
// 脚手架桩：下列路径一律返回 501。由「L0 本地实现者」实现（保持 register(app, c) 的签名；具体路由按需细化）。
import type { Express } from 'express';
import type { Container } from '../../container.js';
import { notImplementedRoute } from './_stub.js';

export const PATHS = [
  '/social/*rest',
  '/api/shares',
  '/api/shares/*rest',
] as const;

export function register(app: Express, _c: Container): void {
  app.all([...PATHS], notImplementedRoute('social'));
}
