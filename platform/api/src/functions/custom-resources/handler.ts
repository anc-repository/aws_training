/**
 * atl-custom-resources — CloudFormation custom resources (Preflight, SeedData, WebDeploy, JwksPublish, SchemaMigrator, StackGuard, UninstallGuard, BucketEmptier) and UninstallRoleCleanup (01 §4).
 * Scaffold: the action table is empty; the implementer of 01 §4 adds actions here. Unknown actions throw
 * `Atl.NotImplemented` (visible to Step Functions as the error name).
 */
import { createActionDispatcher, type ActionHandler, type DepsProvider } from '../../runtime/deps.js';

export const FUNCTION_NAME = 'atl-custom-resources';

export const ACTIONS: Record<string, ActionHandler> = {};

export function createCustomResourcesHandler(getDeps: DepsProvider, actions: Record<string, ActionHandler> = ACTIONS) {
  return createActionDispatcher(FUNCTION_NAME, actions, getDeps);
}
