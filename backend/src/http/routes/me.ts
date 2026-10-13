// backend/src/http/routes/me.ts —— GET /api/me（当前用户）、/api/me/outbox*（本人邮件预览，email=outbox；处理器在 routes/auth.ts）
//
// - GET /api/me：Principal → users 行（local 按主键；cognito 按 sub JIT 建档，services/user-directory.ts）→ toMe()。
//   未验证邮箱的受限会话也能读（restricted=true），前端据此提示去 /me/outbox 点验证链接。
// - /api/me/outbox、/api/me/outbox/:id：routes/auth.ts 的 registerSelfOutbox()（总纲 §11 把 /me/outbox 放在 me.ts）。
import type { Express } from 'express';
import type { Container } from '../../container.js';
import { currentContext } from '../../observability/request-context.js';
import { toMe, UserDirectory } from '../../services/user-directory.js';
import { requireAuth } from '../middleware/auth.js';
import { registerSelfOutbox } from './auth.js';

export const PATHS = [
  '/api/me',
  '/api/me/*rest',
] as const;

export function register(app: Express, c: Container): void {
  registerSelfOutbox(app, c);
  const directory = new UserDirectory(c.db);

  app.get('/api/me', requireAuth, async (_req, res) => {
    const principal = currentContext()!.principal!;
    const user = await directory.ensureUser(principal);
    res.set('Cache-Control', 'private, no-store').json(toMe(user, principal));
  });

  app.all('/api/me/*rest', (req, res) => {
    res.status(404).json({ error: 'NOT_FOUND', path: req.path });
  });
}
