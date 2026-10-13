// backend/src/http/routes/capabilities.ts —— GET /api/capabilities 与 SSE /api/capabilities/stream（总纲 6.1、6.3）
//
// - 无需登录即可访问（前端启动时就要知道登录方式、媒体域名等）；Cache-Control: no-store，带 ETag；
// - 匿名与普通用户看到精简视图；管理员看到完整视图；?deep=1 只对管理员有效，触发一次深度探针；
// - /stream：已打开 /lab 的管理员经 SSE 实时接收状态变化（先推一次快照，再推 transition 事件）；
// - 响应的路径头带 config=<driver>:v<N>（运行时配置的快照版本，02#config：用来观察热键的传播）。
import { createHash } from 'node:crypto';
import type { Express } from 'express';
import { PLATFORM_HEADERS, ProjectionError, isModuleId, projectCapabilities } from '@cloudalbum/contracts';
import type { Container } from '../../container.js';
import { currentContext, markPath } from '../../observability/request-context.js';
import { probeErrorBody, probeErrorOf, probeErrorStatus } from '../middleware/atl-probe.js';

/** 运行时配置快照版本记入路径头（ConfigPort 不可用时不记） */
export function markConfigVersion(c: Container): void {
  try {
    const src = c.runtime.describeSource();
    markPath('config', `${src.driver}${src.version ? `:${src.version.toLowerCase().replace(/[^a-z0-9-]/g, '')}` : ''}`);
  } catch {
    /* ConfigPort 未实现或读取失败 */
  }
}

function etagOf(body: unknown): string {
  const { generatedAt: _g, ...rest } = body as Record<string, unknown>;
  return `W/"${createHash('sha256').update(JSON.stringify(rest)).digest('base64url').slice(0, 27)}"`;
}

export function register(app: Express, c: Container): void {
  app.get('/api/capabilities', async (req, res) => {
    const ctx = currentContext();
    const deep = req.query.deep === '1' || req.query.deep === 'true';
    // ATL 平台模式（06 PM-03、PM-10）：探测主体 atl-probe 可以取管理员视图（view=admin），但不能触发深度探针
    const wantsAdmin = req.query.view === 'admin';
    const probe = Boolean(ctx?.probePrincipal) && wantsAdmin && !ctx?.isAdmin;
    if (wantsAdmin && !ctx?.isAdmin && !ctx?.probePrincipal && req.get(PLATFORM_HEADERS.probeToken)) {
      const code = probeErrorOf(ctx);
      res.status(probeErrorStatus(code)).set('Cache-Control', 'private, no-store').json(probeErrorBody(code));
      return;
    }
    if (probe && deep) {
      res.status(403).set('Cache-Control', 'private, no-store')
        .json({ error: { code: 'PROBE_DEEP_FORBIDDEN', message: 'atl-probe 不能触发深度探针（deep=1）' } });
      return;
    }
    const admin = Boolean(ctx?.isAdmin) || probe;
    if (ctx?.isAdmin && deep) {
      await c.capabilities.probeAll({ deep: true, timeoutMs: 5000 });
    }
    markConfigVersion(c);
    let body: object = c.capabilities.snapshot(admin ? 'admin' : 'public');
    // ?fields= / ?modules= 投影（06 PM-03；两种模式都可用，不带参数时响应与原来逐字节一致）
    const fields = typeof req.query.fields === 'string' ? req.query.fields : undefined;
    const modules = typeof req.query.modules === 'string' ? req.query.modules : undefined;
    if (fields !== undefined || modules !== undefined) {
      try {
        body = projectCapabilities(body, { ...(fields !== undefined ? { fields } : {}), ...(modules !== undefined ? { modules } : {}), isModuleId }).body;
      } catch (e) {
        if (!(e instanceof ProjectionError)) throw e;
        res.status(400).set('Cache-Control', 'private, no-store').json({ error: { code: e.code, message: e.message } });
        return;
      }
    }
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
