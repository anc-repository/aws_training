/**
 * Route tables of the three HTTP functions (01 §8.2) and their handler factories:
 *
 *   atl-api     createApiHttpHandler(getDeps, ext)     — every JWT route
 *   atl-agent   createAgentHttpHandler(getDeps, ext)   — agent, internal and the fallback route
 *   atl-public  createPublicHttpHandler(getDeps)       — public routes (functions/public/handler.ts, owned by atl-certs)
 *
 * The factories add the `IdempotencyRecord` store (01 §7.5 item 3) and audit every 403 (01 §8.5).
 */
import type { ResolvedRouteDef } from '@atl/shared';
import { createHttpHandler, type RouteHandlers } from '../http/router.js';
import type { HttpEvent } from '../http/types.js';
import { createRepositories } from '../repositories/index.js';
import type { DepsProvider, FunctionDeps } from '../runtime/deps.js';
import { audit, userAgentHash } from '../services/events/index.js';
import { ROUTE_HANDLERS as PUBLIC_ROUTE_HANDLERS } from '../functions/public/handler.js';
import { agentRoutes } from './agent.js';
import { catalogRoutes } from './catalog.js';
import { gapRoutes } from './gaps.js';
import type { ApiExtensions } from './extensions.js';
import { platformRoutes } from './platform.js';
import { progressRoutes } from './progress.js';
import { reportRoutes } from './reports.js';
import { sessionRoutes } from './sessions.js';
import { workspaceRoutes } from './workspace.js';

export function apiRouteHandlers(ext: ApiExtensions = {}): RouteHandlers {
  const base: RouteHandlers = {
    ...platformRoutes(ext),
    ...catalogRoutes(ext),
    ...sessionRoutes(ext),
    ...workspaceRoutes(ext),
    ...progressRoutes(ext),
    ...reportRoutes(ext),
  };
  // 08 §9.2: routes pending 01 registration and refinements of registered ones (routes/gaps.ts)
  return { ...base, ...gapRoutes(ext, base) };
}

export function agentRouteHandlers(ext: ApiExtensions = {}): RouteHandlers {
  return agentRoutes(ext);
}

/** atl-public: the certs-owned implementation (functions/public/handler.ts) is the only one (integration decision). */
export function publicRouteHandlers(_ext: ApiExtensions = {}): RouteHandlers {
  return PUBLIC_ROUTE_HANDLERS;
}

/** Routes whose repeated POSTs are part of the protocol (they are idempotent by construction). */
const IDEMPOTENCY_EXEMPT = new Set(['createExport', 'heartbeat']);

async function auditDenied(
  r: { route: ResolvedRouteDef; code: string; event: HttpEvent; principal?: { sub: string; groups: string[] } },
  deps: FunctionDeps,
): Promise<void> {
  const repos = createRepositories(deps.db, deps.env.tableName);
  const sid = /\/sessions\/(s[0-9a-hjkmnp-tv-z]{12})(\/|$)/.exec(r.event.rawPath)?.[1] ?? null;
  const callerArn = r.event.requestContext.authorizer?.iam?.userArn ?? null;
  await audit(deps, repos, {
    action: 'access.denied',
    actor: { sub: r.principal?.sub ?? callerArn, role: r.principal?.groups.join(',') || (callerArn ? 'iam' : 'anonymous'), via: r.route.kind === 'jwt' ? 'web' : r.route.kind === 'internal' ? 'internal' : 'agent' },
    target: `${r.route.method} ${r.route.path}`,
    sessionId: sid,
    result: 'denied',
    sourceIp: r.event.requestContext.http.sourceIp ?? null,
    userAgentHash: userAgentHash(r.event.headers?.['user-agent']),
    details: { route: r.route.id, code: r.code },
  });
}

function common(getDeps: DepsProvider) {
  return {
    getDeps,
    onDenied: auditDenied,
    idempotency: { store: (deps: FunctionDeps) => createRepositories(deps.db, deps.env.tableName).idempotency, exempt: IDEMPOTENCY_EXEMPT },
  };
}

export function createApiHttpHandler(getDeps: DepsProvider, ext: ApiExtensions = {}) {
  return createHttpHandler({ fn: 'atl-api', handlers: apiRouteHandlers(ext), ...common(getDeps) });
}

export function createAgentHttpHandler(getDeps: DepsProvider, ext: ApiExtensions = {}) {
  return createHttpHandler({ fn: 'atl-agent', handlers: agentRouteHandlers(ext), ...common(getDeps) });
}

export function createPublicHttpHandler(getDeps: DepsProvider, ext: ApiExtensions = {}) {
  return createHttpHandler({ fn: 'atl-public', handlers: publicRouteHandlers(ext), getDeps });
}

export type { ApiExtensions } from './extensions.js';
export { DOWNSTREAM_ACTIONS } from './extensions.js';
