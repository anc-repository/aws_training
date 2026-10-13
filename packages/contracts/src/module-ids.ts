/**
 * Module ids, statuses and bypass keys (modular-design.md §4.2 `ports/common.ts`).
 * This is the single TypeScript definition; backend `ports/common.ts` re-exports it.
 */

/** 共 40 个（D11）。顺序与总纲 §4.2 一致。 */
export const MODULE_IDS = [
  'ec2', 'network', 'cdn', 'dns', 'tls', 'waf', 'load-balancer', 'autoscaling',
  'iam', 'auth', 'identity-pool', 'secrets', 'config', 'kms',
  'storage', 'shared-fs', 'database', 'cache', 'social-store', 'backup', 'analytics',
  'image-processing', 'queue', 'notification', 'email', 'scheduler', 'tagging', 'social-api',
  'shell-access', 'logging', 'monitoring', 'tracing', 'audit', 'threat-detection',
  'compliance', 'vuln-scan', 'cost', 'db-proxy', 'workflow', 'ami',
] as const;

export type ModuleId = (typeof MODULE_IDS)[number];

const MODULE_ID_SET: ReadonlySet<string> = new Set(MODULE_IDS);

export function isModuleId(value: string): value is ModuleId {
  return MODULE_ID_SET.has(value);
}

/** `off` = 模块未启用（正在使用本地实现，含本地档）；本地实现自身的健康见 `localHealth`。 */
export const MODULE_STATUSES = ['off', 'ok', 'degraded', 'error'] as const;
export type ModuleStatus = (typeof MODULE_STATUSES)[number];
export type HealthStatus = Exclude<ModuleStatus, 'off'>;

/** 共 10 个，白名单见总纲 8.3。 */
export const BYPASS_KEYS = [
  'cache', 'cdn', 'queue', 'image', 'tagger', 'tracing', 'analytics', 'replica', 'kms', 'identity-pool',
] as const;
export type BypassKey = (typeof BYPASS_KEYS)[number];

const BYPASS_KEY_SET: ReadonlySet<string> = new Set(BYPASS_KEYS);

export function isBypassKey(value: string): value is BypassKey {
  return BYPASS_KEY_SET.has(value);
}

/** 模块类型（总纲 3.1）：A = adapter，A·P = param，I = infra，base = ec2。 */
export type ModuleType = 'adapter' | 'param' | 'infra' | 'base';
export type ModuleGroup = 'base' | 'A' | 'B' | 'C' | 'D' | 'E' | 'F';
export type CredentialsRequirement = 'required' | 'optional' | 'none';

/**
 * `MODULE_<ID>` 变量名：id 中的 `-` 换成 `_` 并大写（总纲 3.1），例如 `load-balancer` → `MODULE_LOAD_BALANCER`。
 */
export function moduleFlagKey(id: ModuleId): string {
  return `MODULE_${id.toUpperCase().replace(/-/g, '_')}`;
}

/** `MODULE_<ID>_VERSION`（CFG-006）。 */
export function moduleVersionKey(id: ModuleId): string {
  return `${moduleFlagKey(id)}_VERSION`;
}
