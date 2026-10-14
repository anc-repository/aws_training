/**
 * Registry helpers for scripts/module (modular-design.md 3.4 / 3.5). The data is the generated registry of
 * @cloudalbum/contracts; the switch / ownership semantics mirror backend/src/modules/registry.ts so that the plan
 * computed on the operator machine agrees with the rule engine that runs on the instance.
 */
import {
  MODULE_IDS, isModuleId, isParamSwitch, moduleFlagKey, moduleVersionKey,
  type ModuleId, type RegistryModule, type EnumSwitch,
} from '@cloudalbum/contracts';
import { REGISTRY_DOCUMENT } from '@cloudalbum/contracts/registry';

export type Registry = Readonly<Record<ModuleId, RegistryModule>>;
export const REGISTRY: Registry = REGISTRY_DOCUMENT.modules;
export { MODULE_IDS, isModuleId, moduleFlagKey, moduleVersionKey };
export type EnvView = Readonly<Record<string, string | undefined>>;

/** The 8 MVP modules (templates, adapters, hooks.ts). */
export const MVP_MODULES: readonly ModuleId[] = [
  'iam', 'storage', 'cdn', 'auth', 'queue', 'image-processing', 'cache', 'database',
];

/** Wave 1 modules (same list as backend config/implemented.ts WAVE1_MODULES; module-specific logic in module-hooks/<id>.ts). */
export const WAVE1_MODULES: readonly ModuleId[] = [
  'notification', 'email', 'monitoring', 'cost', 'logging', 'shell-access', 'dns', 'tls', 'waf', 'identity-pool',
];

/** Modules whose templates and adapters exist (+ ec2): enable / profile apply refuse the others. */
export const IMPLEMENTED_MODULES: readonly ModuleId[] = [...MVP_MODULES, ...WAVE1_MODULES];

/** Parameter switches: [local driver, AWS driver] (same table as backend PARAM_DRIVERS). */
export const PARAM_DRIVERS: Readonly<Partial<Record<ModuleId, readonly [string, string]>>> = {
  cdn: ['direct', 'cloudfront'],
  'identity-pool': ['none', 'cognito'],
  kms: ['local', 'kms'],
  'social-api': ['express', 'apigw'],
};

/** Logical secret names (mirror of backend/src/ports/secrets.ts SECRET_NAMES; a unit test checks for drift). */
export const SECRET_NAMES = [
  'jwt-signing-key', 'upload-hmac-key', 'media-hmac-key', 'callback-hmac-key', 'internal-hmac-key',
  'cookie-secret', 'local-master-key', 'db-password', 'redis-auth-token', 'origin-verify',
  'cognito-client-secret', 'cloudfront-signing-key',
] as const;
export type SecretName = (typeof SECRET_NAMES)[number];
const FILE_SECRETS = new Set<string>(['jwt-signing-key', 'cloudfront-signing-key']);

/** env variable of a logical secret (env driver): jwt-signing-key -> JWT_SIGNING_KEY_FILE, origin-verify -> ORIGIN_VERIFY */
export function secretEnvName(name: string): string {
  const base = name.toUpperCase().replace(/-/g, '_');
  return FILE_SECRETS.has(name) ? `${base}_FILE` : base;
}

const SECRET_ENV_KEYS: ReadonlySet<string> = new Set(SECRET_NAMES.flatMap((n) => {
  const k = secretEnvName(n);
  return k.endsWith('_FILE') ? [k, k.slice(0, -'_FILE'.length)] : [k, `${k}_FILE`];
}));

/** Secret-like keys never allowed in modules.d (CFG-002; same definition as backend load-env isSecretLikeKey). */
export function isSecretLikeKey(key: string): boolean {
  if (key.endsWith('_SECRET_ARN') || key.endsWith('_SECRET_NAME')) return false;
  if (SECRET_ENV_KEYS.has(key) || key.startsWith('IAM_KEYS_')) return true;
  return /(_SECRET|_PASSWORD|_TOKEN|_PRIVATE_KEY)$/.test(key);
}

export function moduleOf(id: ModuleId, registry: Registry = REGISTRY): RegistryModule {
  const m = registry[id];
  if (!m) throw new Error(`unknown module: ${id}`);
  return m;
}

export function switchVar(id: ModuleId, registry: Registry = REGISTRY): string | undefined {
  return registry[id]?.switch?.var;
}

export function enumSwitch(id: ModuleId, registry: Registry = REGISTRY): EnumSwitch | undefined {
  const sw = registry[id]?.switch;
  return sw && !isParamSwitch(sw) ? sw : undefined;
}

/** Local value of a switch (values[0]; '' for parameter switches). */
export function localValue(id: ModuleId, registry: Registry = REGISTRY): string {
  const sw = registry[id]?.switch;
  if (!sw) return '';
  return isParamSwitch(sw) ? '' : (sw.values[0] ?? '');
}

export function switchValue(env: EnvView, id: ModuleId, registry: Registry = REGISTRY): string {
  const sw = registry[id]?.switch;
  if (!sw) return '';
  const v = env[sw.var];
  return v === undefined || v === '' ? localValue(id, registry) : v;
}

export function isLoopback(value: string | undefined): boolean {
  if (!value) return false;
  let host = value;
  const m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?(\[[^\]]+\]|[^:/?#]+)/i.exec(value);
  if (m?.[1]) host = m[1];
  host = host.replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || host === '::1' || /^127\.\d+\.\d+\.\d+$/.test(host);
}

export function isSelfHosted(env: EnvView, id: ModuleId, registry: Registry = REGISTRY): boolean {
  const m = registry[id];
  if (!m?.selfHosted) return false;
  if (switchValue(env, id, registry) !== m.selfHosted.driver) return false;
  return Object.entries(m.selfHosted.match).every(([k, expected]) =>
    expected === 'loopback' ? isLoopback(env[k]) : (env[k] ?? '') === expected);
}

/** AWS implementation enabled (= MODULE_<ID>=on): owned AWS value and not self-hosted. ec2 is always on. */
export function isEnabled(env: EnvView, id: ModuleId, registry: Registry = REGISTRY): boolean {
  if (id === 'ec2') return true;
  const sw = registry[id]?.switch;
  if (!sw) return false;
  const owned = isParamSwitch(sw) ? Boolean(env[sw.var]) : sw.ownedValues.includes(switchValue(env, id, registry));
  return owned && !isSelfHosted(env, id, registry);
}

/** Switch left its local default (AWS value, local tier or self-hosted). */
export function isActive(env: EnvView, id: ModuleId, registry: Registry = REGISTRY): boolean {
  if (id === 'ec2') return true;
  const sw = registry[id]?.switch;
  if (!sw) return false;
  if (isParamSwitch(sw)) return Boolean(env[sw.var]);
  return switchValue(env, id, registry) !== localValue(id, registry);
}

export function driverOf(env: EnvView, id: ModuleId, registry: Registry = REGISTRY): string {
  if (id === 'ec2') return env.DEPLOY_MODE || 'single';
  const sw = registry[id]?.switch;
  if (!sw) return '';
  if (isParamSwitch(sw)) return (PARAM_DRIVERS[id] ?? ['local', 'aws'])[env[sw.var] ? 1 : 0];
  return switchValue(env, id, registry);
}

/** ownsEnv: longest-prefix ownership (DB_PROXY_ -> db-proxy, other DB_ -> database); full key names win. */
export function ownerOfKey(key: string, registry: Registry = REGISTRY): ModuleId | undefined {
  let best: { id: ModuleId; len: number } | undefined;
  for (const id of MODULE_IDS) {
    for (const entry of registry[id]?.ownsEnv ?? []) {
      const match = entry.endsWith('_') ? key.startsWith(entry) : key === entry;
      if (!match) continue;
      const len = entry.endsWith('_') ? entry.length : entry.length + 1000;
      if (!best || len > best.len) best = { id, len };
    }
  }
  return best?.id;
}

/** Keys allowed in modules.d/<id>.env (CFG-002): MODULE_<ID>(_VERSION), the switch variable, ownsEnv keys. */
export function isKeyAllowedForModule(key: string, id: ModuleId, registry: Registry = REGISTRY): boolean {
  if (key === moduleFlagKey(id) || key === moduleVersionKey(id)) return true;
  if (switchVar(id, registry) === key) return true;
  return ownerOfKey(key, registry) === id;
}

export function registryVersion(id: ModuleId, registry: Registry = REGISTRY): number {
  return registry[id]?.version ?? 1;
}

/** Stack name of a module stack: cloudalbum-<env>-<id>[-<name>] ("main" has no suffix). */
export function stackName(env: string, id: ModuleId | 'toolchain', name = 'main'): string {
  return name === 'main' ? `cloudalbum-${env}-${id}` : `cloudalbum-${env}-${id}-${name}`;
}

/** Modules whose AWS implementation is billed per hour (registry billing / lab.hourlyBilled). */
export function isHourlyBilled(id: ModuleId, registry: Registry = REGISTRY): boolean {
  const m = registry[id];
  return Boolean(m?.lab?.hourlyBilled) || Boolean(m?.billing?.some((b) => b.hourly));
}

export function parseModuleId(value: string): ModuleId {
  if (!isModuleId(value)) throw new Error(`unknown module "${value}" (known: ${MODULE_IDS.join(', ')})`);
  return value;
}
