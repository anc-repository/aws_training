/**
 * atl-certs — reports, exports, shares, certificates, revocation lists, JWKS (04 §9, §10).
 * Scaffold: the action table is empty; the implementer of 04 §9, §10 adds actions here. Unknown actions throw
 * `Atl.NotImplemented` (visible to Step Functions as the error name).
 */
import { createActionDispatcher, type ActionHandler, type DepsProvider } from '../../runtime/deps.js';

export const FUNCTION_NAME = 'atl-certs';

export const ACTIONS: Record<string, ActionHandler> = {};

export function createCertsHandler(getDeps: DepsProvider, actions: Record<string, ActionHandler> = ACTIONS) {
  return createActionDispatcher(FUNCTION_NAME, actions, getDeps);
}
