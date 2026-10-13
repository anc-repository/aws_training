// backend/src/modules/registry.ts —— 读取构建时内联的注册表（modules/registry.yaml → @cloudalbum/contracts/registry）
//
// 提供“开关取值 → 驱动 / 是否启用 / 是否本地档”的统一推导，container、规则引擎、capabilities 与 load-env 共用。
import {
  MODULE_IDS, isParamSwitch, moduleFlagKey, moduleVersionKey,
  type ModuleId, type RegistryModule, type ModuleSwitch,
} from '@cloudalbum/contracts';
import { REGISTRY_DOCUMENT } from '@cloudalbum/contracts/registry';
import { isLoopback } from '../config/net.js';

export type Registry = Readonly<Record<ModuleId, RegistryModule>>;
export const REGISTRY: Registry = REGISTRY_DOCUMENT.modules;
export { MODULE_IDS, moduleFlagKey, moduleVersionKey };

/** 一份扁平的 env 视图（分层合并后的原始值，或 parseConfig 的 effective）。 */
export type EnvView = Readonly<Record<string, string | undefined>>;

/** 参数型开关推导出的驱动名（总纲 6.1）：[本地驱动, AWS 驱动] */
export const PARAM_DRIVERS: Readonly<Partial<Record<ModuleId, readonly [string, string]>>> = {
  cdn: ['direct', 'cloudfront'],
  'identity-pool': ['none', 'cognito'],
  kms: ['local', 'kms'],
  'social-api': ['express', 'apigw'],
};

export function switchOf(id: ModuleId, registry: Registry = REGISTRY): ModuleSwitch | undefined {
  return registry[id]?.switch;
}

/** 开关的本地取值（values[0]；参数型为空字符串）。 */
export function localSwitchValue(id: ModuleId, registry: Registry = REGISTRY): string {
  const sw = switchOf(id, registry);
  if (!sw) return '';
  return isParamSwitch(sw) ? '' : (sw.values[0] ?? '');
}

/** 开关的当前取值（缺省 = 本地取值）。 */
export function switchValue(env: EnvView, id: ModuleId, registry: Registry = REGISTRY): string {
  const sw = switchOf(id, registry);
  if (!sw) return '';
  const v = env[sw.var];
  return v === undefined || v === '' ? localSwitchValue(id, registry) : v;
}

/**
 * 驱动名 = 开关取值；参数型模块为推导出的驱动名（cdn direct|cloudfront、identity-pool none|cognito、
 * kms local|kms、social-api express|apigw）；ec2 为 DEPLOY_MODE（single|asg）。
 */
export function driverOf(env: EnvView, id: ModuleId, registry: Registry = REGISTRY): string {
  if (id === 'ec2') return env.DEPLOY_MODE || 'single';
  const sw = switchOf(id, registry);
  if (!sw) return '';
  if (isParamSwitch(sw)) {
    const pair = PARAM_DRIVERS[id] ?? ['local', 'aws'];
    return env[sw.var] ? pair[1] : pair[0];
  }
  return switchValue(env, id, registry);
}

/** 本地实现的驱动名（off 时的 driver）。 */
export function localDriverOf(id: ModuleId, registry: Registry = REGISTRY): string {
  if (id === 'ec2') return 'single';
  const sw = switchOf(id, registry);
  if (!sw) return '';
  if (isParamSwitch(sw)) return (PARAM_DRIVERS[id] ?? ['local', 'aws'])[0];
  return sw.values[0] ?? '';
}

/** 开关是否取本模块拥有的 AWS 值（参数型：非空）。 */
export function isOwnedValue(env: EnvView, id: ModuleId, registry: Registry = REGISTRY): boolean {
  const sw = switchOf(id, registry);
  if (!sw) return false;
  if (isParamSwitch(sw)) return Boolean(env[sw.var]);
  return sw.ownedValues.includes(switchValue(env, id, registry));
}

/** 是否命中 selfHosted.match（EC2 自建的本地档，例如 REDIS_URL 是回环地址）；只在开关取 selfHosted.driver 时生效。 */
export function isSelfHosted(env: EnvView, id: ModuleId, registry: Registry = REGISTRY): boolean {
  const m = registry[id];
  if (!m?.selfHosted) return false;
  if (switchValue(env, id, registry) !== m.selfHosted.driver) return false;
  return Object.entries(m.selfHosted.match).every(([k, expected]) =>
    expected === 'loopback' ? isLoopback(env[k]) : (env[k] ?? '') === expected);
}

/** 开关是否取 localTiers 中的值（不需要 AWS 资源的中间档）。 */
export function isLocalTier(env: EnvView, id: ModuleId, registry: Registry = REGISTRY): boolean {
  const sw = switchOf(id, registry);
  if (!sw || isParamSwitch(sw)) return false;
  return sw.localTiers.includes(switchValue(env, id, registry));
}

/**
 * 模块（AWS 实现）是否启用：开关取本模块拥有的 AWS 值，且没有命中 selfHosted.match。ec2 恒为 true。
 * 这就是规则引擎的 `enabled()` 与 registry 表达式中“模块 id”项的含义（= MODULE_<ID>=on，CFG-004 保证两者一致）。
 */
export function isEnabled(env: EnvView, id: ModuleId, registry: Registry = REGISTRY): boolean {
  if (id === 'ec2') return true;
  return isOwnedValue(env, id, registry) && !isSelfHosted(env, id, registry);
}

/** 开关是否离开了本地默认值（AWS 实现、本地档或自建档）。 */
export function isActive(env: EnvView, id: ModuleId, registry: Registry = REGISTRY): boolean {
  if (id === 'ec2') return true;
  const sw = switchOf(id, registry);
  if (!sw) return false;
  if (isParamSwitch(sw)) return Boolean(env[sw.var]);
  return switchValue(env, id, registry) !== localSwitchValue(id, registry);
}

/** `MODULE_<ID>=on` 是否写入 */
export function moduleFlagOn(env: EnvView, id: ModuleId): boolean {
  return (env[moduleFlagKey(id)] ?? '').toLowerCase() === 'on';
}

export function enabledModules(env: EnvView, registry: Registry = REGISTRY): ModuleId[] {
  return MODULE_IDS.filter((id) => id !== 'ec2' && isEnabled(env, id, registry));
}

export function registryVersion(id: ModuleId, registry: Registry = REGISTRY): number {
  return registry[id]?.version ?? 1;
}

/**
 * ownsEnv 归属：按“最长前缀”唯一归属（总纲 3.5，例如 DB_PROXY_ 归 db-proxy，其余 DB_ 归 database）。
 * 以 `_` 结尾的项是前缀，其余是完整键名。返回 undefined 表示不属于任何模块。
 */
export function ownerOfKey(key: string, registry: Registry = REGISTRY): ModuleId | undefined {
  let best: { id: ModuleId; len: number } | undefined;
  for (const id of MODULE_IDS) {
    for (const entry of registry[id]?.ownsEnv ?? []) {
      const match = entry.endsWith('_') ? key.startsWith(entry) : key === entry;
      if (!match) continue;
      const len = entry.endsWith('_') ? entry.length : entry.length + 1000;   // 完整键名优先于任何前缀
      if (!best || len > best.len) best = { id, len };
    }
  }
  return best?.id;
}

/** 某个模块的 modules.d 文件允许出现的键（CFG-002）：ownsEnv（按最长前缀归属）+ MODULE_<ID>(_VERSION) + 它拥有取值的开关变量。 */
export function isKeyAllowedForModule(key: string, id: ModuleId, registry: Registry = REGISTRY): boolean {
  if (key === moduleFlagKey(id) || key === moduleVersionKey(id)) return true;
  const sw = switchOf(id, registry);
  if (sw && sw.var === key) return true;
  return ownerOfKey(key, registry) === id;
}
