/**
 * atl-api — every browser route `/api/v1/*` (JWT), 01 §3.2, §8.2.
 * Scaffold: only `getTime` is implemented (02 §5.5, it needs nothing but the clock); the API implementer registers the
 * other route handlers by id in `ROUTE_HANDLERS` (route ids come from @atl/shared ROUTES). Unregistered routes answer 501.
 */
import { createHttpHandler, json, type RouteHandlers } from '../../http/router.js';
import type { DepsProvider } from '../../runtime/deps.js';

export const ROUTE_HANDLERS: RouteHandlers = {
  getTime: async ({ deps }) => json(200, { serverNow: deps.ports.clock.now().toISOString() }, { 'cache-control': 'no-store' }),
};

export function createApiHandler(getDeps: DepsProvider, handlers: RouteHandlers = ROUTE_HANDLERS) {
  return createHttpHandler({ fn: 'atl-api', handlers, getDeps });
}
