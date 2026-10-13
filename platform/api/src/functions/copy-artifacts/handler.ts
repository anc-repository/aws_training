/**
 * atl-copy-artifacts — CopyArtifacts custom resource (inline code embedded in the template at build time) (01 §4.5).
 * Scaffold: the action table is empty; the implementer of 01 §4.5 adds actions here. Unknown actions throw
 * `Atl.NotImplemented` (visible to Step Functions as the error name).
 */
import { createActionDispatcher, type ActionHandler, type DepsProvider } from '../../runtime/deps.js';

export const FUNCTION_NAME = 'atl-copy-artifacts';

export const ACTIONS: Record<string, ActionHandler> = {};

export function createCopyArtifactsHandler(getDeps: DepsProvider, actions: Record<string, ActionHandler> = ACTIONS) {
  return createActionDispatcher(FUNCTION_NAME, actions, getDeps);
}
