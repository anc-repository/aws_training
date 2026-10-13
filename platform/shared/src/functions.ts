/**
 * Lambda functions and their cross-document action names — 01 §3.2 (name-table rows “Lambda”, “动作名”), 02 §13.6.
 * Functions dispatch on `{ action }` (single-function routing per permission domain).
 */

export const LAMBDA_FUNCTIONS = [
  'atl-api',
  'atl-public',
  'atl-agent',
  'atl-checks',
  'atl-lifecycle',
  'atl-timer',
  'atl-reaper',
  'atl-certs',
  'atl-pricing',
  'atl-custom-resources',
  'atl-copy-artifacts',
  'atl-tagger',
] as const;
export type LambdaFunctionName = (typeof LAMBDA_FUNCTIONS)[number];

/** Optional functions (only deployed under a parameter): `atl-tagger` (PlatformTrail=enabled). */
export const OPTIONAL_LAMBDA_FUNCTIONS = ['atl-tagger'] as const satisfies readonly LambdaFunctionName[];

/** Old names in 02 → current function (01 §14). */
export const DEPRECATED_FUNCTION_NAMES = {
  'atl-reclaim': 'atl-reaper',
  'atl-watchdog': 'atl-timer',
  'atl-uninstall-guard': 'atl-custom-resources',
} as const;

/** Source directory of each function under `platform/api/src/functions/` (01 §13). */
export const FUNCTION_SOURCE_DIR: Readonly<Record<LambdaFunctionName, string>> = {
  'atl-api': 'api',
  'atl-public': 'public',
  'atl-agent': 'agent',
  'atl-checks': 'checks',
  'atl-lifecycle': 'lifecycle',
  'atl-timer': 'timer',
  'atl-reaper': 'reaper',
  'atl-certs': 'certs',
  'atl-pricing': 'pricing',
  'atl-custom-resources': 'custom-resources',
  'atl-copy-artifacts': 'copy-artifacts',
  'atl-tagger': 'tagger',
};

/**
 * Action names registered in 01 / 02 (“等” in 01 means the defining document may add more; add them here when they are
 * used across documents, e.g. by an ASL file).
 */
export const LIFECYCLE_ACTIONS = [
  'CreateSession',
  'Transition',
  'Extend',
  'WireWorkstation',
  'CloseLearnerAccess',
  'SealRevocation',
  'Conclude',
  'BudgetAlert',
  'OpenOutageWindow',
  // used by the 02 §4.4 ASL skeleton
  'ValidateQuote',
  'AcquireLock',
  'Preflight',
] as const;
export const CHECKS_ACTIONS = ['FinalizeAttempt'] as const;
export const REAPER_ACTIONS = ['CaptureLedger', 'OwnershipLookup'] as const;
export const CUSTOM_RESOURCE_HANDLERS = [
  'Preflight',
  'CopyArtifacts',
  'SeedData',
  'WebDeploy',
  'JwksPublish',
  'SchemaMigrator',
  'StackGuard',
  'UninstallGuard',
  'BucketEmptier',
] as const;
export const CUSTOM_RESOURCE_ACTIONS = ['UninstallRoleCleanup'] as const;

/** `atl-timer` payload kinds (01 §3.5). */
export const TIMER_KINDS = [
  'WARN_15',
  'WARN_5',
  'EXPIRE',
  'READY_IDLE',
  'KEEP_WARN_60',
  'KEEP_WARN_15',
  'KEEP_EXPIRE',
  'SHARE_EXPIRE',
  'SWEEP',
] as const;
export type TimerKind = (typeof TIMER_KINDS)[number];

/** Health gates run by `atl-checks` through ATL-RunCheck (01 §3.2, 02). */
export const HEALTH_GATES = ['base.ready', 'caps.profile', 'ws.ready'] as const;
