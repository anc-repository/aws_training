/**
 * HTTP dispatch for atl-api / atl-agent / atl-public, driven by the shared route table (01 §8.2):
 * route match → authentication by route family (JWT / agent SigV4 / internal SigV4 / public) → RBAC → recent-login check →
 * `Idempotency-Key` presence → handler. Errors become `application/problem+json` (01 §8.1).
 * Implementers register handlers by route id; unregistered routes answer 501.
 */
import {
  allowedMethods,
  AtlError,
  matchRoute,
  problem,
  type JwtPrincipal,
  type ResolvedRouteDef,
  type RouteFunction,
  type RouteId,
} from '@atl/shared';
import { checkAgentCaller, checkInternalCaller, type AgentCaller, type InternalCaller } from '../auth/callers.js';
import { isRecentAuth, isRouteAllowed } from '../auth/rbac.js';
import type { DepsProvider, FunctionDeps } from '../runtime/deps.js';
import { header, json, parseJsonBody, type HttpEvent, type HttpResult } from './types.js';

export interface RouteRequest {
  event: HttpEvent;
  route: ResolvedRouteDef;
  params: Record<string, string>;
  query: Record<string, string>;
  body: unknown;
  requestId: string;
  idempotencyKey: string | undefined;
  /** JWT routes. */
  principal?: JwtPrincipal;
  /** agent routes. */
  agent?: AgentCaller;
  /** internal routes. */
  internal?: InternalCaller;
  deps: FunctionDeps;
}

export type RouteHandler = (req: RouteRequest) => Promise<HttpResult>;
export type RouteHandlers = Partial<Record<RouteId, RouteHandler>>;

const PROBLEM_TYPE = { 'content-type': 'application/problem+json; charset=utf-8' };

function problemResult(status: number, body: Record<string, unknown>): HttpResult {
  return { statusCode: status, headers: { ...PROBLEM_TYPE, 'cache-control': 'no-store' }, body: JSON.stringify(body) };
}

export interface HttpHandlerOptions {
  fn: RouteFunction;
  handlers: RouteHandlers;
  getDeps: DepsProvider;
  /** Hook for audit of denied requests (01 §8.5: every 403 is audited). */
  onDenied?: (req: { route: ResolvedRouteDef; code: string; event: HttpEvent }, deps: FunctionDeps) => Promise<void>;
}

export function createHttpHandler(opts: HttpHandlerOptions): (event: HttpEvent) => Promise<HttpResult> {
  return async (event) => {
    const requestId = event.requestContext.requestId ?? cryptoRandomId();
    const method = event.requestContext.http.method.toUpperCase();
    const m = matchRoute(method, event.rawPath);
    if (!m || m.route.fn !== opts.fn) {
      if (!m && allowedMethods(event.rawPath).length > 0) {
        return problemResult(405, { ...problem('NOT_FOUND', `method ${method} not allowed`), status: 405, requestId });
      }
      return problemResult(404, { ...problem('NOT_FOUND', `no route ${method} ${event.rawPath}`), requestId });
    }
    const { route, params } = m;
    let deps: FunctionDeps | undefined;
    try {
      deps = await opts.getDeps();
      const req: RouteRequest = {
        event,
        route,
        params,
        query: Object.fromEntries(Object.entries(event.queryStringParameters ?? {}).filter(([, v]) => v !== undefined)) as Record<string, string>,
        body: undefined,
        requestId,
        idempotencyKey: header(event, 'idempotency-key'),
        deps,
      };
      await authenticate(req, deps);
      if (route.idempotent && route.kind !== 'agent-fallback' && !req.idempotencyKey) {
        throw new AtlError('VALIDATION_FAILED', 'Idempotency-Key header is required');
      }
      try {
        req.body = parseJsonBody(event);
      } catch {
        throw new AtlError('VALIDATION_FAILED', 'request body is not valid JSON');
      }
      const h = opts.handlers[route.id as RouteId];
      if (!h) {
        return problemResult(501, {
          type: 'urn:atl:error:NOT_IMPLEMENTED',
          title: 'Not implemented',
          status: 501,
          code: 'NOT_IMPLEMENTED',
          detail: `route ${route.id} (${route.method} ${route.path}) is not implemented yet`,
          requestId,
        });
      }
      return await h(req);
    } catch (e) {
      if (e instanceof AtlError) {
        if (e.status === 403 && deps && opts.onDenied) await opts.onDenied({ route, code: e.code, event }, deps).catch(() => undefined);
        return problemResult(e.status, { ...e.toProblem(requestId) });
      }
      console.error(JSON.stringify({ level: 'error', msg: 'unhandled error', route: route.id, requestId, error: String(e) }));
      return problemResult(500, { ...problem('INTERNAL'), requestId });
    }
  };
}

async function authenticate(req: RouteRequest, deps: FunctionDeps): Promise<void> {
  const { route, event, params } = req;
  switch (route.kind) {
    case 'public':
    case 'agent-fallback':
      return;
    case 'agent':
      req.agent = checkAgentCaller(event.requestContext.authorizer?.iam?.userArn, params.sid ?? '', deps.env.accountId);
      return;
    case 'internal':
      req.internal = checkInternalCaller(
        event.requestContext.authorizer?.iam?.userArn,
        { sid: params.sid, runId: params.runId },
        deps.env.accountId,
      );
      return;
    case 'jwt': {
      const auth = header(event, 'authorization');
      const token = auth?.startsWith('Bearer ') ? auth.slice(7).trim() : undefined;
      if (!token) throw new AtlError('UNAUTHENTICATED', 'missing bearer token');
      const principal = await deps.ports.auth.verifyAccessToken(token);
      if (!isRouteAllowed(route, principal.groups)) throw new AtlError('FORBIDDEN_ROLE', `route ${route.id} is not allowed for ${principal.groups.join(',') || 'no group'}`);
      if (route.recentAuth && !isRecentAuth(principal.authTime, deps.ports.clock.nowMs())) {
        throw new AtlError('REAUTH_REQUIRED', 'this operation requires a login within the last 60 minutes');
      }
      req.principal = principal;
      return;
    }
  }
}

function cryptoRandomId(): string {
  return globalThis.crypto.randomUUID();
}

export { json };
