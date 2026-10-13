import type { Repositories } from '../../repositories/index.js';
import type { FunctionDeps } from '../../runtime/deps.js';
import type { CatalogStore } from '../catalog/store.js';
import type { Actor, LifecycleClient } from './lifecycle-client.js';

/** What the session services need (the route context satisfies it). */
export interface ServiceContext {
  deps: FunctionDeps;
  repos: Repositories;
  catalog: CatalogStore;
  lifecycle: LifecycleClient;
  nowMs: number;
  nowIso: string;
}

export type { Actor };
