// 认证中间件：令牌无效（4xx）按匿名处理；校验依赖故障（5xx，例如 Cognito JWKS 不可达）返回 503，不降级为匿名（总纲 1.2）
import express, { type ErrorRequestHandler } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type { Container } from '../../src/container.js';
import { HttpError } from '../../src/errors.js';
import { authenticate, requireAuth } from '../../src/http/middleware/auth.js';
import { requestContext } from '../../src/http/middleware/request-context.js';
import { currentContext } from '../../src/observability/request-context.js';
import type { Principal } from '../../src/ports/auth.js';

function appWith(verify: (token: string) => Promise<Principal>) {
  const c = {
    db: {} as Container['db'],
    config: { core: { APP_BASE_URL: 'http://localhost:3000', CDN_BASE_URL: '' } },
    auth: { verifyAccessToken: verify },
  } as unknown as Container;
  const app = express();
  app.use(requestContext());
  app.use(authenticate(c));
  app.get('/api/feed', (_req, res) => { res.json({ scope: currentContext()?.principal ? 'mine' : 'public' }); });
  app.get('/api/me', requireAuth, (_req, res) => { res.json({ ok: true }); });
  app.get('/api/capabilities', (_req, res) => { res.json({ anonymous: !currentContext()?.principal }); });
  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    const e = err as HttpError;
    res.status(e.status ?? 500).json({ error: e.code ?? 'INTERNAL' });
  };
  app.use(onError);
  return app;
}

const principal: Principal = { provider: 'local', subject: 'u1', email: 'u1@example.com', emailVerified: true, groups: ['member'], plan: 'free', expiresAt: 0 };

describe('authenticate：令牌无效 vs 依赖故障', () => {
  it('令牌有效 → 已登录', async () => {
    const app = appWith(async () => principal);
    expect((await request(app).get('/api/feed').set('Authorization', 'Bearer t').expect(200)).body.scope).toBe('mine');
  });

  it('令牌无效（401）→ 匿名：公开接口照常，requireAuth 返回 401 并带原因', async () => {
    const app = appWith(async () => { throw new HttpError(401, 'INVALID_TOKEN', 'bad'); });
    expect((await request(app).get('/api/feed').set('Authorization', 'Bearer t').expect(200)).body.scope).toBe('public');
    expect((await request(app).get('/api/me').set('Authorization', 'Bearer t').expect(401)).body).toMatchObject({ error: 'UNAUTHENTICATED', reason: 'INVALID_TOKEN' });
  });

  it('JWKS 不可达（503 AUTH_UNAVAILABLE）→ 503，不当作匿名；能力清单这类公开端点仍匿名响应', async () => {
    const app = appWith(async () => { throw new HttpError(503, 'AUTH_UNAVAILABLE', 'jwks timeout'); });
    expect((await request(app).get('/api/feed').set('Authorization', 'Bearer t').expect(503)).body.error).toBe('AUTH_UNAVAILABLE');
    expect((await request(app).get('/api/me').set('Authorization', 'Bearer t').expect(503)).body.error).toBe('AUTH_UNAVAILABLE');
    expect((await request(app).get('/api/capabilities').set('Authorization', 'Bearer t').expect(200)).body.anonymous).toBe(true);
  });

  it('非 HTTP 错误（例如数据库故障）→ 500，不当作匿名', async () => {
    const app = appWith(async () => { throw new Error('SQLITE_BUSY'); });
    await request(app).get('/api/feed').set('Authorization', 'Bearer t').expect(500);
  });
});
