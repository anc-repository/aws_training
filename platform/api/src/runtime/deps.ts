/**
 * What every function handler receives. Production entries (`functions/<fn>/index.ts`) build it from `aws/`; the dev
 * runtime (`dev/`) builds it from dev adapters. Handlers never construct SDK clients or ports themselves.
 */
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { PlatformPorts } from '@atl/shared';
import type { PlatformEnv } from './env.js';

export interface FunctionDeps {
  ports: PlatformPorts;
  /** DynamoDB document client for `atl-main` / `cloudalbum-lab-locks` (dev: DynamoDB Local). */
  db: DynamoDBDocumentClient;
  env: PlatformEnv;
}

export type DepsProvider = () => Promise<FunctionDeps>;

/** Memoize a provider: cold start builds the deps once per container. */
export function memoDeps(build: () => Promise<FunctionDeps>): DepsProvider {
  let p: Promise<FunctionDeps> | null = null;
  return () => {
    p ??= build().catch((e: unknown) => {
      p = null;
      throw e;
    });
    return p;
  };
}

/** Error thrown by a non-HTTP action that is not implemented yet (reaches Step Functions as `Atl.NotImplemented`). */
export class ActionNotImplementedError extends Error {
  constructor(fn: string, action: string) {
    super(`${fn}: action ${action} is not implemented yet`);
    this.name = 'Atl.NotImplemented';
  }
}

/** Generic `{ action }` dispatcher for the action-routed functions (01 §3.2). */
export type ActionHandler = (payload: Record<string, unknown>, deps: FunctionDeps) => Promise<unknown>;

export function createActionDispatcher(fn: string, actions: Record<string, ActionHandler>, getDeps: DepsProvider) {
  return async (event: unknown): Promise<unknown> => {
    const payload = (event && typeof event === 'object' ? event : {}) as Record<string, unknown>;
    const action = typeof payload.action === 'string' ? payload.action : typeof payload.kind === 'string' ? payload.kind : '';
    const h = actions[action];
    if (!h) throw new ActionNotImplementedError(fn, action || '(none)');
    return h(payload, await getDeps());
  };
}
