/**
 * atl-agent — workstation routes `/api/v1/agent/*` (caller `ATLLearnerRole/atl-<sid>-ws`) and runner routes
 * `/api/v1/internal/*` (caller `ATLProvisionerRole/atl-<sid>-prov-*`), 01 §3.2, §5.3, §8.2.
 * The router already enforces the caller ARN rules; handlers still apply the session-state gates of 01 §5.3
 * (`AGENT_STATE_GATES` in @atl/shared) after reading the session.
 * Scaffold: no route implemented yet (501). The context route must use `buildAgentContext()` from @atl/shared.
 */
import { createHttpHandler, type RouteHandlers } from '../../http/router.js';
import type { DepsProvider } from '../../runtime/deps.js';

export const ROUTE_HANDLERS: RouteHandlers = {};

export function createAgentHandler(getDeps: DepsProvider, handlers: RouteHandlers = ROUTE_HANDLERS) {
  return createHttpHandler({ fn: 'atl-agent', handlers, getDeps });
}
