/**
 * atl-pricing — quotes from the Price List API (no hard-coded prices) (04 §3.4, 02 §3.2).
 * Scaffold: the action table is empty; the implementer of 04 §3.4, 02 §3.2 adds actions here. Unknown actions throw
 * `Atl.NotImplemented` (visible to Step Functions as the error name).
 */
import { createActionDispatcher, type ActionHandler, type DepsProvider } from '../../runtime/deps.js';

export const FUNCTION_NAME = 'atl-pricing';

export const ACTIONS: Record<string, ActionHandler> = {};

export function createPricingHandler(getDeps: DepsProvider, actions: Record<string, ActionHandler> = ACTIONS) {
  return createActionDispatcher(FUNCTION_NAME, actions, getDeps);
}
