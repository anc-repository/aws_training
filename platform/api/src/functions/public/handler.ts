/**
 * atl-public — `/api/v1/public/*` (no auth; least fields), 01 §3.2, §8.2. May only read `CERT#*` and `KEY#*` partitions.
 * Scaffold: `publicHealth` answers with the platform version only.
 */
import { createHttpHandler, json, type RouteHandlers } from '../../http/router.js';
import type { DepsProvider } from '../../runtime/deps.js';

export const PLATFORM_VERSION = process.env.ATL_PLATFORM_VERSION ?? '0.1.0-dev';

export const ROUTE_HANDLERS: RouteHandlers = {
  publicHealth: async () => json(200, { status: 'ok', version: PLATFORM_VERSION }, { 'cache-control': 'no-store' }),
};

export function createPublicHandler(getDeps: DepsProvider, handlers: RouteHandlers = ROUTE_HANDLERS) {
  return createHttpHandler({ fn: 'atl-public', handlers, getDeps });
}
