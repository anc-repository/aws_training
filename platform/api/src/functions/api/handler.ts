/**
 * atl-api — every browser route `/api/v1/*` (JWT), 01 §3.2, §8.2. The route table lives in `src/routes/` (platform,
 * catalog, sessions, workspace, progress, reports); `createApiHttpHandler` adds the IdempotencyRecord store and the 403
 * audit. `ext` carries the optional providers (03 WorkspaceProvider, Cognito MemberDirectory): without them those routes
 * answer 501.
 */
import type { DepsProvider } from '../../runtime/deps.js';
import { createApiHttpHandler, type ApiExtensions } from '../../routes/index.js';

export function createApiHandler(getDeps: DepsProvider, ext: ApiExtensions = {}) {
  return createApiHttpHandler(getDeps, ext);
}
