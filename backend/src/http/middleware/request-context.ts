// backend/src/http/middleware/request-context.ts —— 为每个请求建立 AsyncLocalStorage 上下文
//
// - 请求 ID：优先用 Nginx 的 $request_id（cloudalbum_proxy.conf 的 X-Request-Id），否则生成 UUID；响应头 X-CloudAlbum-Request-Id。
// - 入口链：Nginx 的 $ca_entry 经 X-CloudAlbum-Entry 传入（只信任来自回环地址的值——客户端 IP 与协议只在 Nginx 解析一次，
//   Express 的 trust proxy 固定为 loopback）；没有 Nginx（开发机直连）时记为 `direct`。
// - 必须挂在 body 解析器之后：body 解析在流事件回调中完成，会丢失 AsyncLocalStorage 上下文。
import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';
import { HEADERS, sanitizePathValue } from '@cloudalbum/contracts';
import { isLoopback } from '../../config/net.js';
import { createRequestContext, runWithContext } from '../../observability/request-context.js';

const REQUEST_ID_RE = /^[A-Za-z0-9._-]{8,64}$/;

export function requestContext(): RequestHandler {
  return (req, res, next) => {
    const upstream = req.get(HEADERS.upstreamRequestId);
    const requestId = upstream && REQUEST_ID_RE.test(upstream) ? upstream : randomUUID();
    const trusted = isLoopback(req.socket.remoteAddress ?? '');
    const entryHeader = trusted ? req.get(HEADERS.entry) : undefined;
    const ctx = createRequestContext({
      requestId,
      method: req.method,
      ...(entryHeader ? { entry: sanitizePathValue(entryHeader) } : {}),
    });
    res.locals.requestContext = ctx;
    res.setHeader(HEADERS.requestId, requestId);
    runWithContext(ctx, () => next());
  };
}
