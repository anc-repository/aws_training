/**
 * Stack Outputs -> modules.d/<id>.env (modular-design.md 9.1 "Outputs naming", 9.2 step 4).
 *   ModuleId, ModuleVersion  required
 *   PolicyArn                customer managed policy, attached by scripts/module (never written to env)
 *   Env<PascalCase>          written to modules.d/<id>.env: EnvStorageS3RawBucket -> STORAGE_S3_RAW_BUCKET
 *   Info<Name>               display only (status, admin view, injects)
 *   anything else            base context (ec2 base stack: InstanceId, VpcId, ...)
 * Abbreviations are written as words (Url, Db, Sqs); EnvSQSQueueURL is rejected.
 */
import type { ModuleId } from '@cloudalbum/contracts';
import {
  REGISTRY, isKeyAllowedForModule, isSecretLikeKey, moduleFlagKey, moduleVersionKey, registryVersion, switchVar,
  type Registry,
} from './registry.js';
import type { EnvMap } from './env-file.js';

export class OutputNameError extends Error {}

/** EnvStorageS3RawBucket -> STORAGE_S3_RAW_BUCKET */
export function outputNameToEnvKey(outputName: string): string {
  if (!outputName.startsWith('Env') || outputName.length <= 3) throw new OutputNameError(`not an Env* output: ${outputName}`);
  const body = outputName.slice(3);
  if (!/^[A-Z]/.test(body)) throw new OutputNameError(`Env* output must continue with an upper-case word: ${outputName}`);
  if (/[A-Z]{2}/.test(body)) {
    throw new OutputNameError(`abbreviations must be written as words (Url, Db, Sqs), got ${outputName}`);
  }
  const words = body.match(/[A-Z][a-z0-9]*/g) ?? [];
  if (words.join('') !== body) throw new OutputNameError(`invalid characters in ${outputName}`);
  return words.map((w) => w.toUpperCase()).join('_');
}

/** STORAGE_S3_RAW_BUCKET -> EnvStorageS3RawBucket (inverse of outputNameToEnvKey) */
export function envKeyToOutputName(key: string): string {
  return `Env${key.split('_').filter(Boolean).map((w) => w.charAt(0) + w.slice(1).toLowerCase()).join('')}`;
}

export type OutputKind = 'module-id' | 'module-version' | 'policy' | 'env' | 'info' | 'context';

export function classifyOutput(name: string): OutputKind {
  if (name === 'ModuleId') return 'module-id';
  if (name === 'ModuleVersion') return 'module-version';
  if (name === 'PolicyArn') return 'policy';
  if (/^Env[A-Z]/.test(name)) return 'env';
  if (/^Info[A-Z]/.test(name)) return 'info';
  return 'context';
}

export interface SplitOutputs {
  moduleId?: string;
  moduleVersion?: string;
  policyArn?: string;
  /** env key -> value, in declaration order */
  env: EnvMap;
  info: Record<string, string>;
  context: Record<string, string>;
}

export function splitOutputs(outputs: Readonly<Record<string, string>>): SplitOutputs {
  const r: SplitOutputs = { env: {}, info: {}, context: {} };
  for (const [name, value] of Object.entries(outputs)) {
    switch (classifyOutput(name)) {
      case 'module-id': r.moduleId = value; break;
      case 'module-version': r.moduleVersion = value; break;
      case 'policy': r.policyArn = value; break;
      case 'env': r.env[outputNameToEnvKey(name)] = value; break;
      case 'info': r.info[name] = value; break;
      default: r.context[name] = value;
    }
  }
  return r;
}

export class EnvOwnershipError extends Error {
  constructor(readonly module: ModuleId, readonly problems: string[]) {
    super(`modules.d/${module}.env would violate CFG-002:\n  - ${problems.join('\n  - ')}`);
  }
}

/** CFG-002 on the operator side: every key belongs to the module (ownsEnv / switch / MODULE_*) and none is secret-like. */
export function validateModuleEnv(id: ModuleId, env: Readonly<EnvMap>, registry: Registry = REGISTRY): string[] {
  const problems: string[] = [];
  for (const key of Object.keys(env)) {
    if (isSecretLikeKey(key)) problems.push(`${key}: secret-like keys never go to modules.d (secrets.env or *_SECRET_ARN only)`);
    else if (!isKeyAllowedForModule(key, id, registry)) problems.push(`${key}: not in ownsEnv of ${id}`);
  }
  return problems;
}

export interface ModuleEnvInput {
  module: ModuleId;
  /** AWS implementation deployed -> MODULE_<ID>=on + MODULE_<ID>_VERSION (local tiers / self-hosted: false) */
  awsTier: boolean;
  /** raw stack outputs (only Env* are used) */
  outputs?: Readonly<Record<string, string>>;
  /** switch value to write (enum switches); param switches get their value from an Env* output */
  switchValue?: string;
  /** additional settings (--set, profile drivers, local tier defaults); override outputs */
  settings?: Readonly<EnvMap>;
  version?: number;
  registry?: Registry;
}

/**
 * Builds the content of modules.d/<id>.env: MODULE flags first (AWS tier only), then the switch variable, then Env*
 * outputs in declaration order, then explicit settings. Throws EnvOwnershipError when CFG-002 would reject it.
 */
export function buildModuleEnv(input: ModuleEnvInput): EnvMap {
  const registry = input.registry ?? REGISTRY;
  const id = input.module;
  const env: EnvMap = {};
  if (input.awsTier) {
    env[moduleFlagKey(id)] = 'on';
    env[moduleVersionKey(id)] = String(input.version ?? registryVersion(id, registry));
  }
  const sv = switchVar(id, registry);
  if (sv && input.switchValue !== undefined && input.switchValue !== '') env[sv] = input.switchValue;
  if (input.outputs) Object.assign(env, splitOutputs(input.outputs).env);
  if (input.settings) Object.assign(env, input.settings);
  const problems = validateModuleEnv(id, env, registry);
  if (problems.length) throw new EnvOwnershipError(id, problems);
  return env;
}
