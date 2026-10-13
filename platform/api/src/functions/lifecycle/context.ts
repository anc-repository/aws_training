/**
 * Per-invocation context of the lifecycle functions: deps, the `atl-main` table, the clock and the cloud ports.
 */
import type { PlatformPorts } from '@atl/shared';
import type { FunctionDeps } from '../../runtime/deps.js';
import type { PlatformEnv } from '../../runtime/env.js';
import { cloudsFor } from './cloud/registry.js';
import type { PlatformClouds } from './cloud/port.js';
import { Table } from './store/ddb.js';

export interface Ctx {
  deps: FunctionDeps;
  ports: PlatformPorts;
  env: PlatformEnv;
  main: Table;
  locks: Table;
  /** Who acts (event `actor`, 02 §13.3). */
  actor: string;
  now(): Date;
  nowMs(): number;
  nowIso(): string;
  clouds(): PlatformClouds;
}

export function makeCtx(deps: FunctionDeps, actor = 'system'): Ctx {
  let clouds: PlatformClouds | null = null;
  return {
    deps,
    ports: deps.ports,
    env: deps.env,
    main: new Table(deps.db, deps.env.tableName),
    locks: new Table(deps.db, deps.env.locksTableName),
    actor,
    now: () => deps.ports.clock.now(),
    nowMs: () => deps.ports.clock.nowMs(),
    nowIso: () => deps.ports.clock.now().toISOString(),
    clouds: () => (clouds ??= cloudsFor(deps)),
  };
}

export const iso = (ms: number): string => new Date(ms).toISOString();
export const ms = (isoTime: string | null | undefined): number => (isoTime ? Date.parse(isoTime) : NaN);
export const MINUTE = 60_000;
