/**
 * Which implementation of the lifecycle ports a function uses. Production entries (`functions/<fn>/index.ts`) register
 * the AWS factory; the ATL_DEV_MODE runtime (`src/orchestrator-dev/`) provides dev implementations per deps object.
 * Nothing here imports either implementation, so handlers stay free of SDK code and of dev code.
 */
import type { FunctionDeps } from '../../../runtime/deps.js';
import type { PlatformEnv } from '../../../runtime/env.js';
import type { PlatformClouds } from './port.js';

const provided = new WeakMap<object, Partial<PlatformClouds>>();
let productionFactory: ((env: PlatformEnv) => PlatformClouds) | null = null;
let production: PlatformClouds | null = null;

/** Called once by the production Lambda entries. */
export function setProductionClouds(factory: (env: PlatformEnv) => PlatformClouds): void {
  productionFactory = factory;
  production = null;
}

/** Dev runtime / tests: attach implementations to one deps object (keyed by its `ports`). */
export function provideClouds(deps: FunctionDeps, clouds: Partial<PlatformClouds>): void {
  provided.set(deps.ports, { ...provided.get(deps.ports), ...clouds });
}

export function cloudsFor(deps: FunctionDeps): PlatformClouds {
  const p = provided.get(deps.ports);
  if (p?.lifecycle && p.reclaim) return p as PlatformClouds;
  if (!deps.env.devMode && productionFactory) {
    production ??= productionFactory(deps.env);
    return { ...production, ...p };
  }
  throw new Error(
    deps.env.devMode
      ? 'lifecycle cloud ports are not wired for ATL_DEV_MODE: call installLifecycleDev(runtime) from platform/api/src/orchestrator-dev'
      : 'lifecycle cloud ports are not wired: the Lambda entry must call setProductionClouds()',
  );
}
