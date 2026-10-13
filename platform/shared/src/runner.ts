/**
 * CodeBuild `atl-runner` — 01 §3.4 (name table row “CodeBuild”), 02 §4.3.
 */

export const RUNNER_PROJECT = 'atl-runner';

/** `ATL_OP` — the only allowed values (01 §3.4). `extra-stack` is enabled since round 3. */
export const ATL_OPS = [
  'base-deploy',
  'resume',
  'profile-apply',
  'workstation-up',
  'workstation-down',
  'module-op',
  'suspend',
  'destroy',
  'repair',
  'diagnose',
  'extra-stack',
] as const;
export type AtlOp = (typeof ATL_OPS)[number];

/** Deprecated names that implementations must not use any more. */
export const DEPRECATED_ATL_OPS = {
  'session-bootstrap': 'base-deploy',
  'session-teardown': 'destroy',
} as const;
/** `ATL_COMMAND` is deprecated (replaced by `ATL_OP`). */
export const DEPRECATED_RUNNER_ENV = ['ATL_COMMAND'] as const;

export function isAtlOp(value: unknown): value is AtlOp {
  return typeof value === 'string' && (ATL_OPS as readonly string[]).includes(value);
}

/**
 * `<op 缩写>` used in runner run IDs (`<sid>-<op abbrev>-<n>[-<m>]`, 01 §3.9).
 * 02 §4.4 uses `base`, `ws`, `apply`, `xstk`, `destroy`; the other abbreviations are fixed here (platform-scaffold).
 */
export const RUN_ID_OP_ABBREV: Readonly<Record<AtlOp, string>> = {
  'base-deploy': 'base',
  resume: 'resume',
  'profile-apply': 'apply',
  'workstation-up': 'ws',
  'workstation-down': 'wsdown',
  'module-op': 'modop',
  suspend: 'suspend',
  destroy: 'destroy',
  repair: 'repair',
  diagnose: 'diag',
  'extra-stack': 'xstk',
};

/** Environment variables of a runner build (01 §3.4 “环境变量”, 02 §4.3). */
export const RUNNER_ENV = {
  op: 'ATL_OP',
  runId: 'ATL_RUN_ID',
  sessionId: 'ATL_SESSION_ID',
  envId: 'ATL_ENV_ID',
  labId: 'ATL_LAB_ID',
  args: 'ATL_ARGS',
  release: 'ATL_RELEASE',
  region: 'ATL_REGION',
  profile: 'ATL_PROFILE',
  applyMode: 'ATL_APPLY_MODE',
  repair: 'ATL_REPAIR',
} as const;

/** `extra-stack` arguments (`ATL_ARGS`, base64url JSON). */
export interface ExtraStackArgs {
  action: 'deploy' | 'destroy';
  stackIds: string[];
}

/** `module-op` arguments: only the action id (01 §3.4). */
export interface ModuleOpArgs {
  actionId: string;
}

/** Runner artifacts under `atl-data/runs/<runId>/` (01 §3.4 “产物”). */
export const RUNNER_ARTIFACTS = ['result.json', 'ledger.json', 'progress.jsonl'] as const;

/** Project-level concurrency of `atl-runner` (01 §3.4). */
export const RUNNER_CONCURRENCY = 2;
