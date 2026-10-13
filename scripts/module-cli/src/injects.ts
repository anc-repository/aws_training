/**
 * Cross-module parameters (modular-design.md 1.2-8, 3.5, 9.1; D2): only the PROVIDER declares `injects`; the target
 * stack declares the parameter as optional (Default ''). No Export / ImportValue.
 *   - target: "<id>" or "*" (every target stack that declares the parameter)
 *   - "+${Out.X}" appends to a list parameter (AppOrigins: union of every entry + the direct entry http://<EIP>)
 *   - when the provider changes or is disabled, the injected parameters of the targets are recomputed (empty when gone)
 */
import type { ModuleId } from '@cloudalbum/contracts';
import { MODULE_IDS, REGISTRY, type Registry } from './registry.js';
import { evaluateExpr, unionList, whenHolds } from './expr.js';
import type { CloudAlbumState, ModuleRecord } from './state.js';
import type { EnvMap } from './env-file.js';

export interface InjectedValue {
  param: string;
  value: string;
  providers: ModuleId[];
}

/** Parameters that some provider may inject into `target` (for one template parameter list). */
export function injectableParams(target: ModuleId, templateParams: readonly string[], registry: Registry = REGISTRY): Set<string> {
  const out = new Set<string>();
  for (const p of MODULE_IDS) {
    for (const inj of registry[p]?.injects ?? []) {
      if (inj.target !== target && inj.target !== '*') continue;
      for (const param of Object.keys(inj.params)) if (templateParams.includes(param)) out.add(param);
    }
  }
  return out;
}

export interface InjectionContext {
  /** modules enabled (AWS tier) with their records, as they will be after the current operation */
  records: Partial<Record<ModuleId, Pick<ModuleRecord, 'outputs' | 'env' | 'params' | 'tier'>>>;
  /** merged env of the instance after the operation (when-clauses) */
  env: Readonly<EnvMap>;
  /** base-context values for list parameters (AppOrigins -> http://<EIP>) */
  baseLists?: Readonly<Record<string, string>>;
  context: { Env: string; Arch?: string };
  placeholders?: boolean;
}

/**
 * Values injected into `target` (one stack) by every enabled provider. Every injectable parameter declared by the
 * template is returned: providers that are gone yield '' so the target is reset (disable flow, 9.1).
 */
export function computeInjections(target: ModuleId, templateParams: readonly string[], ctx: InjectionContext,
  registry: Registry = REGISTRY): Record<string, InjectedValue> {
  const result: Record<string, InjectedValue> = {};
  const lists: Record<string, string[]> = {};
  for (const param of injectableParams(target, templateParams, registry)) {
    result[param] = { param, value: '', providers: [] };
  }
  for (const provider of MODULE_IDS) {
    const rec = ctx.records[provider];
    if (!rec || rec.tier !== 'aws' || provider === target) continue;
    for (const inj of registry[provider]?.injects ?? []) {
      if (inj.target !== target && inj.target !== '*') continue;
      if (!whenHolds(inj.when, { ...ctx.env, ...rec.env })) continue;
      for (const [param, expr] of Object.entries(inj.params)) {
        if (!templateParams.includes(param)) continue;
        const v = evaluateExpr(expr, {
          outputs: rec.outputs, env: rec.env, params: rec.params, context: ctx.context, module: provider,
          ...(ctx.placeholders ? { placeholders: true } : {}),
        });
        if (!v.value || (v.unresolved.length && !ctx.placeholders)) continue;
        const entry = result[param] ?? { param, value: '', providers: [] };
        entry.providers.push(provider);
        if (v.append) lists[param] = unionList(lists[param], v.value);
        else entry.value = v.value;
        result[param] = entry;
      }
    }
  }
  for (const [param, items] of Object.entries(lists)) {
    result[param]!.value = unionList(ctx.baseLists?.[param], items).join(',');
  }
  for (const [param, base] of Object.entries(ctx.baseLists ?? {})) {
    if (result[param] && !result[param]!.value) result[param]!.value = base;
  }
  return result;
}

/** Enabled targets whose stacks receive something from `provider` (to update after the provider changed). */
export function injectTargetsOf(provider: ModuleId, state: Pick<CloudAlbumState, 'modules'>, registry: Registry = REGISTRY): ModuleId[] {
  const targets = new Set<ModuleId>();
  for (const inj of registry[provider]?.injects ?? []) {
    if (inj.target === '*') {
      for (const id of MODULE_IDS) if (id !== provider && state.modules[id]?.tier === 'aws') targets.add(id);
    } else if (state.modules[inj.target]?.tier === 'aws') {
      targets.add(inj.target);
    }
  }
  return [...targets];
}
