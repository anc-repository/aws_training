/**
 * Per-request context of the route handlers: repositories, catalog store, lifecycle client, clock, cursor codec,
 * extensions; plus the common guards (session access, subject resolution for assistants / observers, state gates).
 */
import { ACCESS_STATES, AtlError, isSid, type CognitoGroup, type JwtPrincipal, type SessionState } from '@atl/shared';
import { createCursorCodec, cursorSecret, type CursorCodec } from '../http/pagination.js';
import { sharedRateLimiter, rateLimitOf, type RateBucketName, type RateLimiter } from '../http/rate-limit.js';
import type { RouteRequest } from '../http/router.js';
import { header } from '../http/types.js';
import { createRepositories, type PlatformConfig, type Repositories, type SessionItem } from '../repositories/index.js';
import type { FunctionDeps } from '../runtime/deps.js';
import { CatalogStore } from '../services/catalog/store.js';
import { audit, userAgentHash } from '../services/events/index.js';
import { LifecycleClient, type Actor } from '../services/sessions/lifecycle-client.js';
import type { AuditInput } from '../repositories/index.js';
import type { ApiExtensions } from './extensions.js';

export interface ApiContext {
  req: RouteRequest;
  deps: FunctionDeps;
  repos: Repositories;
  catalog: CatalogStore;
  lifecycle: LifecycleClient;
  cursors: CursorCodec;
  limiter: RateLimiter;
  ext: ApiExtensions;
  nowMs: number;
  nowIso: string;
}

export function createContext(req: RouteRequest, ext: ApiExtensions, limiter: RateLimiter = sharedRateLimiter): ApiContext {
  const deps = req.deps;
  const repos = createRepositories(deps.db, deps.env.tableName);
  const nowMs = deps.ports.clock.nowMs();
  return {
    req,
    deps,
    repos,
    catalog: new CatalogStore(deps, repos.platform),
    lifecycle: new LifecycleClient(deps),
    cursors: createCursorCodec(cursorSecret(deps.env)),
    limiter,
    ext,
    nowMs,
    nowIso: new Date(nowMs).toISOString(),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Principals

export function principalOf(ctx: ApiContext): JwtPrincipal {
  const p = ctx.req.principal;
  if (!p) throw new AtlError('UNAUTHENTICATED', 'no principal');
  return p;
}

export function primaryGroup(p: JwtPrincipal): CognitoGroup {
  return p.groups.includes('learner') ? 'learner' : p.groups.includes('assistant') ? 'assistant' : 'observer';
}

export function actorOf(ctx: ApiContext): Actor {
  const p = ctx.req.principal;
  if (p) return { sub: p.sub, role: primaryGroup(p), via: 'web' };
  if (ctx.req.agent) return { sub: ctx.req.agent.arn, role: 'workstation', via: 'agent' };
  if (ctx.req.internal) return { sub: ctx.req.internal.arn, role: 'runner', via: 'internal' };
  return { sub: 'anonymous', role: 'public', via: 'system' };
}

/**
 * Whose data a “my …” route shows: the learner's own sub; for assistants and observers the single learner of the
 * installation (single-learner model, 01 §5.2; 08 §9.2 #21). `null` when no learner profile exists yet.
 */
export async function subjectSub(ctx: ApiContext): Promise<string | null> {
  const p = principalOf(ctx);
  if (p.groups.includes('learner')) return p.sub;
  const learner = await ctx.repos.users.learner();
  return learner?.sub ?? null;
}

// ---------------------------------------------------------------------------------------------------------------
// Sessions

/** Read a session for the caller (404 for unknown ids; a learner only sees their own sessions). */
export async function loadSession(ctx: ApiContext, sid: string | undefined): Promise<SessionItem> {
  if (!sid || !isSid(sid)) throw new AtlError('NOT_FOUND', 'session not found');
  const s = await ctx.repos.sessions.get(sid, true);
  if (!s) throw new AtlError('NOT_FOUND', `session ${sid} not found`);
  const p = ctx.req.principal;
  if (p && p.groups.includes('learner') && s.sub !== p.sub) throw new AtlError('NOT_FOUND', `session ${sid} not found`);
  return s;
}

/** Browser routes that need a live environment (01 §8.6 `INVALID_STATE`). */
export function requireState(s: SessionItem, states: readonly SessionState[], what: string): void {
  if (!states.includes(s.state)) throw new AtlError('INVALID_STATE', `${what} is not possible while the session is ${s.state}`, { state: s.state });
}

/** “Issuing access” rule (02 §5.1): READY/RUNNING/EXPIRING and `now < deadlineAt`, access not revoked yet. */
export function canIssueAccess(s: SessionItem, nowMs: number): boolean {
  if (!(ACCESS_STATES as readonly SessionState[]).includes(s.state)) return false;
  if (s.revokedAt) return false;
  return !(typeof s.deadlineAt === 'string' && nowMs >= Date.parse(s.deadlineAt));
}

export async function platformConfig(ctx: ApiContext): Promise<PlatformConfig | null> {
  return ctx.repos.platform.config();
}

// ---------------------------------------------------------------------------------------------------------------
// Rate limits and audit

export function rateLimit(ctx: ApiContext, bucket: RateBucketName, key: string, config: PlatformConfig | null): void {
  ctx.limiter.hit(`${bucket}:${key}`, rateLimitOf(bucket, config), ctx.nowMs);
}

export async function auditOk(ctx: ApiContext, action: AuditInput['action'], opts: { sessionId?: string | null; target?: string | null; details?: Record<string, unknown>; result?: AuditInput['result'] } = {}): Promise<void> {
  const actor = actorOf(ctx);
  await audit(ctx.deps, ctx.repos, {
    action,
    actor: { sub: actor.sub, role: actor.role, via: actor.via },
    target: opts.target ?? null,
    sessionId: opts.sessionId ?? null,
    result: opts.result ?? 'ok',
    sourceIp: ctx.req.event.requestContext.http.sourceIp ?? null,
    userAgentHash: userAgentHash(header(ctx.req.event, 'user-agent')),
    ...(opts.details ? { details: opts.details } : {}),
  });
}
