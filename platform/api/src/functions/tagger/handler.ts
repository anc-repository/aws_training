/**
 * atl-tagger — optional real-time tagger (PlatformTrail=enabled) (02 §7.1).
 * Scaffold: the action table is empty; the implementer of 02 §7.1 adds actions here. Unknown actions throw
 * `Atl.NotImplemented` (visible to Step Functions as the error name).
 */
import { createActionDispatcher, type ActionHandler, type DepsProvider } from '../../runtime/deps.js';

export const FUNCTION_NAME = 'atl-tagger';

export const ACTIONS: Record<string, ActionHandler> = {};

export function createTaggerHandler(getDeps: DepsProvider, actions: Record<string, ActionHandler> = ACTIONS) {
  return createActionDispatcher(FUNCTION_NAME, actions, getDeps);
}
