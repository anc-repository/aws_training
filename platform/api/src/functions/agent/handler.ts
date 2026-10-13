/**
 * atl-agent — workstation routes `/api/v1/agent/*` (caller `ATLLearnerRole/atl-<sid>-ws`), runner routes
 * `/api/v1/internal/*` (caller `ATLProvisionerRole/atl-<sid>-prov-*`) and the fallback upload route, 01 §3.2, §5.3, §8.2.
 * The router enforces the caller ARN rules; the handlers in `src/routes/agent.ts` apply the session-state gates of
 * 01 §5.3 (`AGENT_STATE_GATES`) after reading the session.
 */
import type { DepsProvider } from '../../runtime/deps.js';
import { createAgentHttpHandler, type ApiExtensions } from '../../routes/index.js';

export function createAgentHandler(getDeps: DepsProvider, ext: ApiExtensions = {}) {
  return createAgentHttpHandler(getDeps, ext);
}
