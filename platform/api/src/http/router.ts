/**
 * HTTP dispatch for atl-api / atl-agent / atl-public, driven by the shared route table (01 §8.2):
 * route match → authentication by route family (JWT / agent SigV4 / internal SigV4 / public) → RBAC → recent-login check →
 * `Idempotency-Key` presence (and, when a store is configured, `IdempotencyRecord` replay, 01 §7.5 item 3) → handler.
 * Errors become `application/problem+json` (01 §8.1), with `Retry-After` on 429 / 503 (08 §9.2 #19).
 * Implementers register handlers by route id; unregistered routes answer 501.
 */
import { createHash } from 'node:crypto';
import {
  allowedMethods,
  AtlError,
  isPortError,
  matchRoute,
  problem,
  type JwtPrincipal,
  type ResolvedRouteDef,
  type RouteFunction,
  type RouteId,
} from '@atl/shared';
import { checkAgentCaller, checkInternalCaller, type AgentCaller, type InternalCaller } from '../auth/callers.js';
import { isRecentAuth, isRouteAllowed } from '../auth/rbac.js';
import type { IdempotencyRepo, StoredResponse } from '../repositories/audit.js';
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

function problemResult(status: number, body: Record<string, unknown>, headers: Record<string, string> = {}): HttpResult {
  return { statusCode: status, headers: { ...PROBLEM_TYPE, 'cache-control': 'no-store', ...headers }, body: JSON.stringify(body) };
}

export interface IdempotencyOptions {
  store: (deps: FunctionDeps) => IdempotencyRepo;
  /** Routes that manage repeated requests themselves (e.g. `createExport` polls with the same key, 08 §9.2 #16). */
  exempt?: ReadonlySet<string>;
}

export interface HttpHandlerOptions {
  fn: RouteFunction;
  handlers: RouteHandlers;
  getDeps: DepsProvider;
  /** Hook for audit of denied requests (01 §8.5: every 403 is audited). */
  onDenied?: (req: { route: ResolvedRouteDef; code: string; event: HttpEvent; principal?: JwtPrincipal }, deps: FunctionDeps) => Promise<void>;
  /** `IdempotencyRecord` handling (01 §7.5 item 3). Without it only the presence of the header is checked. */
  idempotency?: IdempotencyOptions;
}

/** Codes that carry a `Retry-After` header (seconds). */
const RETRY_AFTER_CODES = new Set(['RATE_LIMITED', 'UPSTREAM_THROTTLED', 'UPSTREAM_UNAVAILABLE']);
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_.:-]{8,128}$/;
const MAX_STORED_BODY = 300_000;

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
    let req: RouteRequest | undefined;
    try {
      deps = await opts.getDeps();
      req = {
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
      const needsKey = route.idempotent && route.kind !== 'agent-fallback';
      if (needsKey && !req.idempotencyKey) {
        throw new AtlError('VALIDATION_FAILED', 'Idempotency-Key header is required');
      }
      try {
        req.body = parseJsonBody(event);
      } catch {
        throw new AtlError('VALIDATION_FAILED', 'request body is not valid JSON');
      }
      const h = opts.handlers[route.id as RouteId];
      if (!h) return notImplemented(route, requestId);
      if (needsKey && opts.idempotency && !opts.idempotency.exempt?.has(route.id)) {
        return await withIdempotency(opts.idempotency.store(deps), req, h, deps);
      }
      return await h(req);
    } catch (e) {
      return errorResult(e, { route, requestId, event, deps, req, onDenied: opts.onDenied });
    }
  };
}

function notImplemented(route: ResolvedRouteDef, requestId: string, detail?: string): HttpResult {
  return problemResult(501, {
    type: 'urn:atl:error:NOT_IMPLEMENTED',
    title: 'Not implemented',
    status: 501,
    code: 'NOT_IMPLEMENTED',
    detail: detail ?? `route ${route.id} (${route.method} ${route.path}) is not implemented yet`,
    requestId,
  });
}

/** Turn any thrown error into problem+json. */
async function errorResult(
  e: unknown,
  c: { route: ResolvedRouteDef; requestId: string; event: HttpEvent; deps: FunctionDeps | undefined; req: RouteRequest | undefined; onDenied: HttpHandlerOptions['onDenied'] },
): Promise<HttpResult> {
  const err = translate(e);
  if (err instanceof AtlError) {
    if (err.status === 403 && c.deps && c.onDenied) {
      await c.onDenied({ route: c.route, code: err.code, event: c.event, ...(c.req?.principal ? { principal: c.req.principal } : {}) }, c.deps).catch(() => undefined);
    }
    const headers: Record<string, string> = {};
    if (RETRY_AFTER_CODES.has(err.code)) {
      const ra = Number(err.extra.retryAfterSeconds);
      headers['retry-after'] = String(Number.isFinite(ra) && ra > 0 ? Math.ceil(ra) : 30);
    }
    return problemResult(err.status, { ...err.toProblem(c.requestId) }, headers);
  }
  if (isNotImplemented(err)) return notImplemented(c.route, c.requestId, (err as Error).message);
  console.error(JSON.stringify({ level: 'error', msg: 'unhandled error', route: c.route.id, requestId: c.requestId, error: String(err), stack: (err as Error)?.stack }));
  return problemResult(500, { ...problem('INTERNAL'), requestId: c.requestId });
}

function isNotImplemented(e: unknown): boolean {
  return isPortError(e, 'NotImplemented') || (e as { name?: string } | null)?.name === 'Atl.NotImplemented';
}

/** Port and SDK errors that have an API meaning (01 §8.6 `UPSTREAM_*`). */
function translate(e: unknown): unknown {
  if (e instanceof AtlError) return e;
  if (isPortError(e, 'Throttled')) return new AtlError('UPSTREAM_THROTTLED', e.message, { retryAfterSeconds: 5 });
  if (isPortError(e, 'Unavailable')) return new AtlError('UPSTREAM_UNAVAILABLE', e.message, { retryAfterSeconds: 10 });
  const name = (e as { name?: string } | null)?.name ?? '';
  if (['ThrottlingException', 'ProvisionedThroughputExceededException', 'RequestLimitExceeded', 'TooManyRequestsException'].includes(name)) {
    return new AtlError('UPSTREAM_THROTTLED', 'an AWS API is throttling requests', { retryAfterSeconds: 5 });
  }
  if (['ServiceUnavailable', 'ServiceUnavailableException', 'InternalServerError', 'InternalFailure'].includes(name)) {
    return new AtlError('UPSTREAM_UNAVAILABLE', 'an AWS service is temporarily unavailable', { retryAfterSeconds: 10 });
  }
  return e;
}

// ---------------------------------------------------------------------------------------------------------------
// Idempotency (01 §7.5 item 3, 02 §2.7): same key + same request → first response; same key + other request → 422.

function idempotencyScope(req: RouteRequest): string {
  if (req.principal) return req.principal.sub;
  if (req.agent) return `ws-${req.agent.sid}`;
  if (req.internal) return `prov-${req.internal.sid}`;
  return 'anonymous';
}

function requestHash(req: RouteRequest): string {
  const body = req.event.body ? (req.event.isBase64Encoded ? Buffer.from(req.event.body, 'base64').toString('utf8') : req.event.body) : '';
  return createHash('sha256').update(`${req.route.id}\n${req.event.rawPath}\n${body}`).digest('hex');
}

async function withIdempotency(store: IdempotencyRepo, req: RouteRequest, h: RouteHandler, deps: FunctionDeps): Promise<HttpResult> {
  const key = req.idempotencyKey!;
  if (!IDEMPOTENCY_KEY_RE.test(key)) throw new AtlError('VALIDATION_FAILED', 'Idempotency-Key must be 8–128 characters of [A-Za-z0-9_.:-]');
  const scope = idempotencyScope(req);
  const hash = requestHash(req);
  const r = await store.reserve(scope, key, req.route.id, hash, deps.ports.clock.nowMs());
  if (r.kind === 'existing') {
    const rec = r.record;
    if (rec.routeId !== req.route.id || rec.requestHash !== hash) {
      return problemResult(422, {
        ...problem('VALIDATION_FAILED', 'Idempotency-Key was already used for a different request'),
        status: 422,
        reason: 'IDEMPOTENCY_KEY_REUSED',
        requestId: req.requestId,
      });
    }
    if (rec.status === 'COMPLETE' && rec.response) {
      return { statusCode: rec.response.statusCode, headers: { ...rec.response.headers, 'idempotent-replayed': 'true' }, body: rec.response.body };
    }
    return problemResult(
      409,
      { ...problem('INVALID_STATE', 'a request with this Idempotency-Key is still being processed'), reason: 'IDEMPOTENCY_IN_PROGRESS', requestId: req.requestId },
      { 'retry-after': '1' },
    );
  }
  let result: HttpResult;
  try {
    result = await h(req);
  } catch (e) {
    await store.release(scope, key).catch(() => undefined);
    throw e;
  }
  if (result.statusCode >= 200 && result.statusCode < 300 && (result.body ?? '').length <= MAX_STORED_BODY) {
    const stored: StoredResponse = { statusCode: result.statusCode, headers: result.headers ?? {}, body: result.body ?? '' };
    await store.complete(scope, key, stored, deps.ports.clock.nowMs()).catch((e: unknown) => {
      console.warn(JSON.stringify({ level: 'warn', msg: 'idempotency record not completed', route: req.route.id, error: String(e) }));
    });
  } else {
    await store.release(scope, key).catch(() => undefined);
  }
  return result;
}

// ---------------------------------------------------------------------------------------------------------------

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
      req.principal = principal;
      if (!isRouteAllowed(route, principal.groups)) throw new AtlError('FORBIDDEN_ROLE', `route ${route.id} is not allowed for ${principal.groups.join(',') || 'no group'}`);
      if (route.recentAuth && !isRecentAuth(principal.authTime, deps.ports.clock.nowMs())) {
        throw new AtlError('REAUTH_REQUIRED', 'this operation requires a login within the last 60 minutes');
      }
      return;
    }
  }
}

function cryptoRandomId(): string {
  return globalThis.crypto.randomUUID();
}

export { json };
