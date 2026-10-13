// backend/src/http/routes/capabilities.ts —— GET /api/capabilities 与 SSE /api/capabilities/stream（总纲 6.1、6.3）
//
// - 无需登录即可访问（前端启动时就要知道登录方式、媒体域名等）；Cache-Control: no-store，带 ETag；
// - 匿名与普通用户看到精简视图；管理员看到完整视图；?deep=1 只对管理员有效，触发一次深度探针；
// - /stream：已打开 /lab 的管理员经 SSE 实时接收状态变化（先推一次快照，再推 transition 事件）。
import { createHash } from 'node:crypto';
import type { Express } from 'express';
import type { Container } from '../../container.js';
import { currentContext } from '../../observability/request-context.js';

function etagOf(body: unknown): string {
  const { generatedAt: _g, ...rest } = body as Record<string, unknown>;
  return `W/"${createHash('sha256').update(JSON.stringify(rest)).digest('base64url').slice(0, 27)}"`;
}

export function register(app: Express, c: Container): void {
  app.get('/api/capabilities', async (req, res) => {
    const ctx = currentContext();
    const admin = Boolean(ctx?.isAdmin);
    if (admin && (req.query.deep === '1' || req.query.deep === 'true')) {
      await c.capabilities.probeAll({ deep: true, timeoutMs: 5000 });
    }
    const body = c.capabilities.snapshot(admin ? 'admin' : 'public');
    const etag = etagOf(body);
    res.set('Cache-Control', 'no-store').set('ETag', etag).set('Vary', 'Cookie, Authorization');
    if (req.get('if-none-match') === etag) {
      res.status(304).end();
      return;
    }
    res.json(body);
  });

  app.get('/api/capabilities/stream', (req, res) => {
    const ctx = currentContext();
    if (!ctx?.isAdmin) {
      res.status(ctx?.principal ? 403 : 401).json({ error: ctx?.principal ? 'FORBIDDEN' : 'UNAUTHENTICATED' });
      return;
    }
    res.status(200).set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',          // Nginx 不缓冲 SSE
    });
    res.flushHeaders();
    const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    send('snapshot', c.capabilities.snapshot('admin'));
    const unsubscribe = c.capabilities.onTransition((e) => send('transition', e));
    const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 25_000);
    heartbeat.unref();
    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });
}
