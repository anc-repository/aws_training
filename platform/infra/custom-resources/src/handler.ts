/**
 * atl-custom-resources — the CloudFormation custom resources of the platform stack (01 §3.2, §4.6–§4.8):
 * Preflight, SeedData, WebDeploy, JwksPublish, SchemaMigrator, StackGuard, UninstallGuard, BucketEmptier (routed by
 * `ResourceType` = `Custom::<Name>`), plus the action `UninstallRoleCleanup` invoked by atl-platform-uninstall
 * (`{ action: 'UninstallRoleCleanup', cfn, outcome, reason }`). Every CloudFormation request is answered (SUCCESS or FAILED
 * with the error message) except UninstallGuard Delete, which is answered by UninstallRoleCleanup.
 * Factory only (no AWS SDK): the Lambda entry is index.ts; tests pass fake ports.
 */
import { CUSTOM_RESOURCE_ACTIONS, CUSTOM_RESOURCE_HANDLERS } from '@atl/shared';
import { callbackOf, defaultPhysicalId, handlerName, isCfnEvent, sendCfnResponse, type CfnEvent, type CfnResult } from './cfn.js';
import { bucketEmptier } from './handlers/bucket-emptier.js';
import { jwksPublish } from './handlers/jwks-publish.js';
import { preflight } from './handlers/preflight.js';
import { schemaMigrator } from './handlers/schema-migrator.js';
import { seedData } from './handlers/seed-data.js';
import { stackGuard } from './handlers/stack-guard.js';
import { uninstallGuard, uninstallRoleCleanup } from './handlers/uninstall.js';
import { webDeploy } from './handlers/web-deploy.js';
import type { Ports } from './ports.js';

export type CfnHandler = (event: CfnEvent, ports: Ports) => Promise<CfnResult>;

/** `CopyArtifacts` is the separate inline function atl-copy-artifacts (01 §4.5). */
export const CFN_HANDLERS: Readonly<Record<string, CfnHandler>> = {
  Preflight: preflight,
  SeedData: seedData,
  WebDeploy: webDeploy,
  JwksPublish: jwksPublish,
  SchemaMigrator: schemaMigrator,
  StackGuard: stackGuard,
  UninstallGuard: uninstallGuard,
  BucketEmptier: bucketEmptier,
};

// keep the registry in sync with the 01 name table (CopyArtifacts is served by atl-copy-artifacts)
for (const name of CUSTOM_RESOURCE_HANDLERS) {
  if (name !== 'CopyArtifacts' && !(name in CFN_HANDLERS)) throw new Error(`custom resource handler ${name} is not implemented`);
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function isMissingTable(e: unknown): boolean {
  return !!e && typeof e === 'object' && (e as { name?: string }).name === 'ResourceNotFoundException';
}

export class ActionNotImplementedError extends Error {
  constructor(action: string) {
    super(`atl-custom-resources: action ${action} is not implemented`);
    this.name = 'Atl.NotImplemented';
  }
}

export function createCustomResourcesHandler(getPorts: () => Promise<Ports>, env: NodeJS.ProcessEnv = process.env) {
  return async (event: unknown): Promise<unknown> => {
    const ports = await getPorts();
    if (isCfnEvent(event)) {
      const name = handlerName(event);
      ports.log('custom resource request', { name, requestType: event.RequestType, logicalId: event.LogicalResourceId });
      let result: CfnResult;
      try {
        const h = CFN_HANDLERS[name];
        if (!h) throw new Error(`unknown custom resource type ${event.ResourceType}`);
        result = await h(event, ports);
      } catch (e) {
        // a Delete that runs after a failed install (rollback) must not block the stack: tables that were never created
        if (event.RequestType === 'Delete' && isMissingTable(e)) {
          result = { physicalResourceId: defaultPhysicalId(event) };
        } else {
          ports.log('custom resource failed', { name, error: errorMessage(e) });
          await sendCfnResponse(callbackOf(event, defaultPhysicalId(event)), 'FAILED', `${name}: ${errorMessage(e)}`, {}, ports.fetch);
          return { status: 'FAILED', reason: errorMessage(e) };
        }
      }
      if (result.noResponse) return { status: 'PENDING' };
      await sendCfnResponse(callbackOf(event, result.physicalResourceId ?? defaultPhysicalId(event)), 'SUCCESS', 'ok', result.data ?? {}, ports.fetch);
      return { status: 'SUCCESS', data: result.data ?? {} };
    }
    const payload = (event && typeof event === 'object' ? event : {}) as Record<string, unknown>;
    const action = typeof payload.action === 'string' ? payload.action : '';
    if ((CUSTOM_RESOURCE_ACTIONS as readonly string[]).includes(action)) {
      const table = env.ATL_TABLE || 'atl-main';
      return uninstallRoleCleanup(payload, ports, table);
    }
    throw new ActionNotImplementedError(action || '(none)');
  };
}
