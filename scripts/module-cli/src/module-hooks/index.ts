/**
 * Registry of the module hooks (wave1-prep). One entry per wave 1 module; the MVP modules keep their logic in ../hooks.ts.
 * Generic helpers used by enable / disable / plan: stack selection from the registry (`stacks[].when` / `region`), output
 * merging of multi-stack modules, and the "conditional stacks of another module changed" note.
 */
import type { ModuleId } from '@cloudalbum/contracts';
import { needHolds } from '../deps.js';
import type { EnvMap } from '../env-file.js';
import { whenHolds } from '../expr.js';
import { CliError, EXIT } from '../printer.js';
import { REGISTRY, isEnabled, type Registry } from '../registry.js';
import type { ModuleRecord } from '../state.js';
import { costHook } from './cost.js';
import { dnsHook } from './dns.js';
import { emailHook } from './email.js';
import { identityPoolHook } from './identity-pool.js';
import { loggingHook } from './logging.js';
import { monitoringHook } from './monitoring.js';
import { notificationHook } from './notification.js';
import { shellAccessHook } from './shell-access.js';
import { tlsHook } from './tls.js';
import type { ModuleHook, StackPlan } from './types.js';
import { wafHook } from './waf.js';

export type * from './types.js';

const HOOKS = new Map<ModuleId, ModuleHook>([
  notificationHook, emailHook, monitoringHook, costHook, loggingHook, shellAccessHook, dnsHook, tlsHook, wafHook, identityPoolHook,
].map((h) => [h.id, h]));

/** The hook of a module (undefined for the MVP modules and the modules of later waves). */
export function hookFor(id: ModuleId): ModuleHook | undefined {
  return HOOKS.get(id);
}

/** Modules that have a hook file (tests: every wave 1 module has one). */
export function hookedModules(): ModuleId[] {
  return [...HOOKS.keys()];
}

/** Tests only: replace a hook temporarily; returns the function that restores the previous one. */
export function setModuleHookForTest(id: ModuleId, hook: Omit<ModuleHook, 'id'>): () => void {
  const prev = HOOKS.get(id);
  HOOKS.set(id, { ...hook, id });
  return () => { if (prev) HOOKS.set(id, prev); else HOOKS.delete(id); };
}

// ------------------------------------------------------------------------------------------------ stacks

/** `when` of a registry stack: a WhenClause object (KEY: value) or a need expression ("cdn", "load-balancer | social-api"). */
export function stackWhenHolds(when: string | Record<string, string> | undefined, env: Readonly<EnvMap>, registry: Registry = REGISTRY): boolean {
  if (when === undefined) return true;
  if (typeof when === 'string') return needHolds(when, env, registry);
  return whenHolds(when, env);
}

/**
 * Registry stacks of a module whose `when` holds for `env` (the env after the operation), in registry order.
 * `region: param:<Name>` is resolved from `params` (stack parameters of this operation); unresolved -> CliError.
 */
export function selectStacks(id: ModuleId, env: Readonly<EnvMap>, defaultRegion: string, params: Readonly<Record<string, string>> = {},
  registry: Registry = REGISTRY): StackPlan[] {
  const out: StackPlan[] = [];
  for (const s of registry[id]?.stacks ?? []) {
    if (!stackWhenHolds(s.when as string | Record<string, string> | undefined, env, registry)) continue;
    let region = defaultRegion;
    if (s.region?.startsWith('param:')) {
      const v = params[s.region.slice('param:'.length)];
      if (!v) throw new CliError(`${id}: stack ${s.name} needs --param ${s.region.slice('param:'.length)}=<region>`, EXIT.rules, 'STACK_REGION');
      region = v;
    } else if (s.region) {
      region = s.region;
    }
    out.push({ name: s.name, template: s.template, region });
  }
  return out;
}

/** Outputs of several stacks in deployment order: a non-empty value wins over an empty one, the first non-empty value is kept. */
export function mergeStackOutputs(list: ReadonlyArray<Readonly<Record<string, string>>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const o of list) {
    for (const [k, v] of Object.entries(o)) {
      if (!(k in out) || (out[k] === '' && v !== '')) out[k] = v;
    }
  }
  return out;
}

/**
 * Enabled AWS-tier modules whose conditional stacks (`stacks[].when`) no longer match what was deployed, e.g. tls was enabled
 * before cdn: the tls edge stack (us-east-1, when: cdn) exists only after `scripts/module enable tls` runs again.
 */
export function stackDrift(records: Partial<Record<ModuleId, ModuleRecord>>, env: Readonly<EnvMap>, defaultRegion: string,
  registry: Registry = REGISTRY): Array<{ module: ModuleId; add: string[]; remove: string[] }> {
  const out: Array<{ module: ModuleId; add: string[]; remove: string[] }> = [];
  for (const [id, rec] of Object.entries(records) as Array<[ModuleId, ModuleRecord | undefined]>) {
    if (!rec || rec.tier !== 'aws') continue;
    const declared = registry[id]?.stacks ?? [];
    if (!declared.some((s) => s.when !== undefined)) continue;
    let wanted: string[];
    try {
      wanted = selectStacks(id, { ...env, ...rec.env }, defaultRegion, rec.params, registry).map((s) => s.name);
    } catch {
      continue;
    }
    const have = rec.stacks.length ? rec.stacks.map((s) => s.name) : ['main'];
    const add = wanted.filter((n) => !have.includes(n));
    const remove = have.filter((n) => !wanted.includes(n));
    if (add.length || remove.length) out.push({ module: id, add, remove });
  }
  return out;
}

/** Is `id` enabled in `env` (AWS tier)? Re-exported for hooks. */
export { isEnabled };
