/**
 * atl-timer — EventBridge Scheduler target: WARN_15 … SHARE_EXPIRE and SWEEP (dispatch on `kind`) (02 §5.3, §5.7).
 * Scaffold: the action table is empty; the implementer of 02 §5.3, §5.7 adds actions here. Unknown actions throw
 * `Atl.NotImplemented` (visible to Step Functions as the error name).
 */
import { createActionDispatcher, type ActionHandler, type DepsProvider } from '../../runtime/deps.js';

export const FUNCTION_NAME = 'atl-timer';

export const ACTIONS: Record<string, ActionHandler> = {};

export function createTimerHandler(getDeps: DepsProvider, actions: Record<string, ActionHandler> = ACTIONS) {
  return createActionDispatcher(FUNCTION_NAME, actions, getDeps);
}
