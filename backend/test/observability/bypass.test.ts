// observability/bypass.ts：X-Compare-Bypass 守卫（总纲 8.3）
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { bypassGuard, isBypassAllowed } from '../../src/observability/bypass.js';
import { currentContext } from '../../src/observability/request-context.js';
import { DEFAULT_RUNTIME_CONFIG, type RuntimeConfig } from '../../src/ports/config.js';
import { requestContext } from '../../src/http/middleware/request-context.js';

function appWith(opts: { admin: boolean; runtime?: Partial<RuntimeConfig>; audit?: unknown[]; maxInFlight?: number }) {
  const app = express();
  app.use(requestContext());
  app.use((_req, _res, next) => {
    const ctx = currentContext()!;
    ctx.isAdmin = opts.admin;
    if (opts.admin) ctx.userId = 'admin-1';
    next();
  });
  app.use(bypassGuard({
    runtime: () => ({ ...DEFAULT_RUNTIME_CONFIG, ...opts.runtime }),
    audit: (e) => { opts.audit?.push(e); },
    ...(opts.maxInFlight ? { maxInFlight: opts.maxInFlight } : {}),
  }));
  app.all('/{*rest}', (_req, res) => {
    const ctx = currentContext()!;
    res.json({ bypass: [...ctx.bypass], experiment: ctx.experiment ?? null });
  });
  return app;
}

describe('X-Compare-Bypass', () => {
  it('白名单：每个键只在指定路由上有效', () => {
    expect(isBypassAllowed('cache', 'GET', '/api/feed')).toBe(true);
    expect(isBypassAllowed('cache', 'POST', '/api/feed')).toBe(false);
    expect(isBypassAllowed('image', 'POST', '/api/photos/abc/complete')).toBe(true);
    expect(isBypassAllowed('kms', 'GET', '/api/photos/abc')).toBe(true);
    expect(isBypassAllowed('kms', 'GET', '/api/photos/abc/comments')).toBe(false);
    expect(isBypassAllowed('identity-pool', 'POST', '/api/uploads/session')).toBe(true);
    expect(isBypassAllowed('tracing', 'DELETE', '/anything')).toBe(true);
  });

  it('非管理员 → 403 BYPASS_FORBIDDEN；X-Experiment-* 同样只对管理员有效', async () => {
    const app = appWith({ admin: false });
    expect((await request(app).get('/api/feed').set('X-Compare-Bypass', 'cache').expect(403)).body.error).toBe('BYPASS_FORBIDDEN');
    expect((await request(app).get('/api/feed').set('X-Experiment-Run', 'r1').expect(403)).body.error).toBe('EXPERIMENT_FORBIDDEN');
    await request(app).get('/api/feed').expect(200);
  });

  it('管理员：设置 ctx.bypass、响应头 X-CloudAlbum-Bypass 与 no-store，并写审计', async () => {
    const audit: unknown[] = [];
    const app = appWith({ admin: true, audit });
    const res = await request(app).get('/api/feed').set('X-Compare-Bypass', 'cache, replica')
      .set('X-Experiment-Run', '01JA3M2C8Y3T5Q6W7E8R9T0Y1U').set('X-Experiment-Label', 'after:A').expect(200);
    expect(res.body.bypass).toEqual(['cache', 'replica']);
    expect(res.body.experiment).toEqual({ runId: '01JA3M2C8Y3T5Q6W7E8R9T0Y1U', label: 'after:A' });
    expect(res.headers['x-cloudalbum-bypass']).toBe('cache,replica');
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(audit).toHaveLength(1);
  });

  it('未知键或不允许的组合 → 400；总开关关闭 → 403', async () => {
    const app = appWith({ admin: true });
    expect((await request(app).get('/api/feed').set('X-Compare-Bypass', 'everything').expect(400)).body.error).toBe('BYPASS_UNKNOWN_KEY');
    expect((await request(app).post('/api/feed').set('X-Compare-Bypass', 'cache').expect(400)).body.error).toBe('BYPASS_NOT_ALLOWED');
    const off = appWith({ admin: true, runtime: { labBypassEnabled: false } });
    expect((await request(off).get('/api/feed').set('X-Compare-Bypass', 'cache').expect(403)).body.error).toBe('BYPASS_DISABLED');
  });
});
