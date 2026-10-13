/**
 * atl-checks — check engine, preflight, health gates, FinalizeAttempt, experiment cross-checks (04, 02).
 * Scaffold: the action table is empty; the implementer of 04, 02 adds actions here. Unknown actions throw
 * `Atl.NotImplemented` (visible to Step Functions as the error name).
 */
import { createActionDispatcher, type ActionHandler, type DepsProvider } from '../../runtime/deps.js';

export const FUNCTION_NAME = 'atl-checks';

export const ACTIONS: Record<string, ActionHandler> = {};

export function createChecksHandler(getDeps: DepsProvider, actions: Record<string, ActionHandler> = ACTIONS) {
  return createActionDispatcher(FUNCTION_NAME, actions, getDeps);
}
